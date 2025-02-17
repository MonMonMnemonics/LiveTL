import { MCHAD, AuthorType, languagesInfo } from './constants.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import * as Ty from './types.js';
import { derived, readable } from 'svelte/store';
import { enableMchadTLs, mchadUsers } from './store.js';
import { combineArr, formatTimestampMillis, sleep, sortBy, toJson } from './utils.js';
import { archiveStreamFromScript, sseToStream } from './api.js';
import { isLangMatch } from './filter.js';

/** @typedef {import('svelte/store').Readable} Readable */
/** @typedef {(unix: Ty.UnixTimestamp) => String} UnixToTimestamp */
/** @typedef {(unix: Ty.UnixTimestamp) => number} UnixToNumber */

/** @type {(videoId: String) => (links: String[]) => Promise<Ty.MCHADLiveRoom[] | Ty.MCHADArchiveRoom[]>} */
const getRoomCreator = videoId => {
  const addVideoId = room => ({ ...room, videoId });
  const getRoom = link =>
    fetch(link).then(r => r.json()).then(r => r.map(addVideoId)).catch(() => []);

  return links => Promise.all(links.map(getRoom)).then(combineArr);
};

/**
 * @param {String} videoLink
 * @returns {{ live: Ty.MCHADLiveRoom[], vod: Ty.MCHADArchiveRoom[] }}
 */
export async function getRooms(videoLink) {
  const getRooms_ = getRoomCreator(videoLink);

  const liveLinks = [
    `${MCHAD}/Room?link=${videoLink}`
  ];

  const vodLinks = [
    `${MCHAD}/Archive?link=${videoLink}`
  ];

  const [live, vod] = await Promise.all([liveLinks, vodLinks].map(getRooms_));

  return { live, vod };
}

/** @type {(tag: String) => String[]} */
const possibleLanguages = tag => languagesInfo.filter(lang => isLangMatch(tag, lang));

/** @type {(tag: String) => String | null} */
export const getRoomTagLanguageCode = tag => {
  const possible = tag
    .split(/\s+/g)
    .map(possibleLanguages)
    .flat();
  return possible[possible.length - 1]?.code ?? null;
};

/** @type {(script: MCHADTL[]) => Number} */
const getFirstTime = script =>
  script.find(s => /--.*Stream.*Start.*--/i.test(s.Stext))?.Stime ??
    script[0]?.Stime ??
    0;

/**
 * @param {Ty.MCHADArchiveRoom} room
 * @returns {Ty.Message[]}
 */
export async function getArchiveFromRoom(room) {
  const script = await fetch(`${MCHAD}/Archive`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      link: room.Link
    })
  }).then(toJson).catch(() => []);

  const firstTime = getFirstTime(script);

  const toMessage = mchadToMessage(room.Room, archiveUnixToTimestamp(firstTime), archiveUnixToNumber(firstTime), getRoomTagLanguageCode(room.Tags));
  return script.map(toMessage);
}

/** @type {(script: Ty.Message[]) => String} */
const getScriptAuthor = script => script[0].author;

/** @type {(arr: Array) => Boolean} */
const isNotEmpty = arr => arr.length !== 0;

/** @type {(videoLink: String) => Readable<Ty.Message>} */
export const getArchive = videoLink => readable(null, async set => {
  const { vod } = await getRooms(videoLink);
  if (vod.length === 0) return () => { };

  const addUnix = tl => ({ ...tl, unix: archiveTimeToInt(tl.timestamp) });

  const getScript = room => getArchiveFromRoom(room)
    .then(s => s.map(addUnix))
    .then(s => s.filter(e => e.unix >= 0))
    .then(sortBy('unix'));
  const scripts = await Promise.all(vod.map(getScript))
    .then(scripts => scripts.filter(isNotEmpty));

  scripts.map(getScriptAuthor).forEach(author => {
    mchadUsers.set(author, mchadUsers.get(author));
  });

  const unsubscribes = scripts
    .map(archiveStreamFromScript)
    .map(stream => stream.subscribe(tl => {
      if (tl && enableMchadTLs.get() && !mchadUsers.get(tl.author)) { set(tl); }
    }));

  return () => unsubscribes.forEach(u => u());
});

/** @type {(room: String) => Readable<Ty.MCHADStreamItem>} */
const streamRoom = room => sseToStream(`${MCHAD}/Listener?room=${room}`);

/** @type {(time: String) => String} */
const removeSeconds = time => time.replace(/:\d\d /, ' ');

/** @type {UnixToTimestamp} */
const liveUnixToTimestamp = unix =>
  removeSeconds(new Date(unix).toLocaleString('en-us').split(', ')[1]);

/** @type {(startUnix: Ty.UnixTimestamp) => UnixToTimestamp} */
const archiveUnixToTimestamp = startUnix => unix => formatTimestampMillis(unix - startUnix);

/** @type {(startUnix: Ty.UnixTimestamp) => UnixToNumber} */
const archiveUnixToNumber = startUnix => unix => unix - startUnix;

/** @type {(archiveTime: String) => Number} */
const archiveTimeToInt = archiveTime => archiveTime
  .split(':')
  .map(t => parseInt(t))
  .map((t, i) => t * Math.pow(60, 2 - i))
  .reduce((l, r) => l + r);

let mchadTLCounter = 0;

/** @type {(author: String, unixToString: UnixToTimestamp, unixToNumber: UnixToNumber, langCode: String | null) => (data: Ty.MCHADTL) => Ty.Message} */
const mchadToMessage = (author, unixToTimestamp, unixToNumber, langCode) => data => ({
  text: data.Stext,
  messageArray: [{ type: 'text', text: data.Stext }],
  author,
  authorId: author,
  langCode,
  messageId: ++mchadTLCounter,
  timestamp: unixToTimestamp(data.Stime),
  types: AuthorType.mchad,
  timestampMs: unixToNumber(data.Stime)
});

/** @type {(room: Ty.MCHADLiveRoom) => Readable<Ty.Message>} */
export const getRoomTranslations = room => derived(streamRoom(room.Nick), (data, set) => {
  if (!enableMchadTLs.get()) return;
  const flag = data?.flag;
  const langCode = getRoomTagLanguageCode(room.Tags);
  const toMessage = mchadToMessage(room.Nick, liveUnixToTimestamp, (u) => u, langCode);
  if (flag === 'insert' || flag === 'update') {
    set(toMessage(data.content));
  }
});

/** @type {(videoLink: String, retryInterval: Ty.Seconds) => Ty.MCHADLiveRoom[]} */
const getLiveRoomsWithRetry = async (videoLink, retryInterval) => {
  for (;;) {
    const { live } = await getRooms(videoLink);
    if (live.length) return live;
    await sleep(retryInterval * 1000);
  }
};

/** @type {(link: String) => Readable<Ty.Message>} */
export const getLiveTranslations = videoLink => readable(null, async set => {
  const rooms = await getLiveRoomsWithRetry(videoLink, 30);
  const unsubscribes = rooms.map(room => getRoomTranslations(room).subscribe(msg => {
    if (msg && enableMchadTLs.get() && !mchadUsers.get(msg.author)) {
      set(msg);
    }
  }));
  return () => unsubscribes.forEach(u => u());
});
