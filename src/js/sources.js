import { compose } from './utils';
import { writable, readable } from 'svelte/store';
import {
  parseTranslation,
  isWhitelisted as textWhitelisted,
  isBlacklisted as textBlacklisted,
  authorWhitelisted,
  authorBlacklisted,
  isTranslation,
  replaceFirstTranslation
} from './filter';
import { showModMessage, showVerifiedMessage, timestamp } from './store';
import { paramsYtVideoId, AuthorType, paramsPopout, paramsTabId, paramsFrameId, paramsTwitchUrl } from './constants';
import * as MCHAD from './mchad.js';
import { twitchSource } from '../ts/sources';
// import * as API from './api.js';

/**
 * @typedef {import('svelte/store').Readable} Readable
 * @typedef {import('svelte/store').Writable} Writable
 * @typedef {import('./types.js').Message} Message
 * @typedef {{ chatTranslations: Writable<Message>, mod: Writable<Message>, verified: Writable<Message>, chat: Writable<Message> }} YTCSources
 */

const mchadLink = paramsTwitchUrl ?? `YT_${paramsYtVideoId}`;

/** @type {YTCSources & { translations: Writable<Message>, mchad: Readable<Message>, api?: Readable<Message>, ytcBonks: Writable<any[]>, ytcDeletions:Writable<any[]>, thirdParty: Writable<Message> }} */
export const sources = {
  chatTranslations: writable(null),
  mod: writable(null),
  verified: writable(null),
  chat: (paramsTwitchUrl ?? '') ? twitchSource() : ytcSource(window).ytc,
  mchad: combineStores(MCHAD.getArchive(mchadLink), MCHAD.getLiveTranslations(mchadLink)).store,
  // api: combineStores(API.getArchive(paramsVideoId), API.getLiveTranslations(paramsVideoId)).store,
  thirdParty: createThirdPartyStore(),
  ytcBonks: writable(null),
  ytcDeletions: writable(null)
};

/** @type {(msg: Message) => Boolean} */
const isWhitelisted = msg => textWhitelisted(msg.text) || authorWhitelisted(msg.author);

/** @type {(msg: Message) => Boolean} */
const isBlacklisted = msg => textBlacklisted(msg.text) || authorBlacklisted(msg.author);

/** @type {(msg: Message) => Boolean} */
const isMod = msg => (msg.types & AuthorType.moderator) || (msg.types & AuthorType.owner);

/** @type {(msg: Message) => Boolean} */
const showIfMod = msg => isMod(msg) && showModMessage.get();

/** @type {(msg: Message) => Boolean} */
const showIfVerified = msg => (msg.types & AuthorType.verified) && showVerifiedMessage.get();

/** @type {(store: Writable<Message>) => (msg: Message, text?: String) => void} */
const setStoreMessage =
  store => (msg, text) => store.set({ ...msg, text: text ?? msg.text });

/** @type {(sources: YTCSources) => () => void} */
function attachFilters({ chatTranslations, mod, verified, chat }) {
  const setTranslation = setStoreMessage(chatTranslations);
  const setModMessage = setStoreMessage(mod);
  const setVerifiedMessage = setStoreMessage(verified);

  return chat.subscribe(message => {
    if (!message || isBlacklisted(message)) return;
    const text = message.text.trim();
    const parsed = parseTranslation(text);

    if (text && isTranslation(parsed)) {
      setTranslation(replaceFirstTranslation(message), parsed.msg);
    } else if (text && isWhitelisted(message)) {
      setTranslation(message);
    } else if (showIfMod(message)) {
      setModMessage(message);
    } else if (showIfVerified(message)) {
      setVerifiedMessage(message);
    }
  });
}

/**
 * @template T
 * @param  {...Writable<T>} stores
 * @returns {{ store: Writable<T>, cleanUp: VoidFunction}}
 */
export function combineStores(...stores) {
  const combined = writable(null);
  const unsubscribes = stores.map(s => s.subscribe(v => combined.set(v)));
  return {
    store: combined,
    cleanUp() {
      unsubscribes.forEach(u => u());
    }
  };
}

function createThirdPartyStore() {
  return readable(null, set => {
    const cb = event => {
      if (event?.data?.type === 'third-party-set') {
        set(event.data.message);
      }
    };
    window.addEventListener('message', cb);
    return () => window.removeEventListener(cb);
  });
}

/**
 * @param {Ytc.ParsedMessage} ytcMessage
 * @returns {Message}
 */
function ytcToMsg(ytcMessage) {
  const text = ytcMessage.message
    .filter(item => item.type === 'text' || item.type === 'link')
    .map(item => item.text)
    .join('');
  const author = ytcMessage.author;
  const typeFlag = author.types.reduce((flag, t) => flag | AuthorType[t], 0);
  return {
    text,
    timestamp: ytcMessage.timestamp,
    author: author.name,
    authorId: author.id,
    types: typeFlag,
    messageArray: ytcMessage.message,
    messageId: ytcMessage.messageId,
    timestampMs: ytcMessage.showtime
  };
}

/** @param {Window} window */
export function ytcSource(window) {
  /** @type {Writable<Message>} */
  const ytc = writable(null);
  const newMessage = compose(ytc.set, ytcToMsg);

  /* Connect to background messaging as client */
  /** @type {Chat.Port} */
  let port;
  try {
    port = chrome.runtime.connect();
  } catch {
    return { ytc, cleanUp: () => {} };
  }
  let portRegistered = false;
  let tryRegister = 0;
  /** @type {Chat.FrameInfo | null} */
  let frameInfo = null;
  const registerClient = () => {
    if (frameInfo == null) {
      console.error('frameInfo is null');
      return;
    }
    port.postMessage({
      type: 'registerClient',
      frameInfo,
      getInitialData: false
    });
    tryRegister++;
  };

  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
  if (paramsPopout && !portRegistered) {
    frameInfo = {
      tabId: parseInt(paramsTabId),
      frameId: parseInt(paramsFrameId)
    };
    registerClient();
  }

  window.addEventListener('message', (d) => {
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    if (!paramsPopout && d.data.type === 'frameInfo' && !portRegistered) {
      frameInfo = d.data.frameInfo;
      registerClient();
    }
  });

  port.onMessage.addListener((response) => {
    switch (response.type) {
      case 'messages':
        response.messages.forEach((m) => newMessage(m.message));
        break;
      case 'bonk': // TODO: No need to use arrays anymore
        sources.ytcBonks.set([response.bonk]);
        break;
      case 'delete':
        sources.ytcDeletions.set([response.deletion]);
        break;
      case 'playerProgress':
        timestamp.set(response.playerProgress);
        break;
      case 'registerClientResponse':
        if (response.success) {
          portRegistered = true;
          break;
        }
        if (tryRegister < 3) {
          setTimeout(registerClient, 500);
        } else {
          console.error(`Failed to connect to YTC source after 3 attempts: ${response.failReason}`);
        }
        break;
    }
  });

  return { ytc, cleanUp: () => port.disconnect() };
}

function message(author, msg, timestamp) {
  const showtime = timestamp
    .split(':')
    .map(e => parseInt(e))
    .reduce((l, r) => l * 10 + r);
  return {
    author: { name: author }, message: [{ type: 'text', text: msg }], timestamp, showtime
  };
}

attachFilters(sources);
sources.translations = combineStores(
  sources.chatTranslations,
  sources.mchad
  // sources.api
).store;

export class DummyYTCEventSource {
  constructor() {
    this.subs = [];
    this.events = [
      { event: 'infoDelivery', info: { currentTime: 0 } },
      {
        type: 'messageChunk',
        isReplay: false,
        messages: [
          message('Author 2', 'Hey there', '03:16 PM'),
          message('Author 1', 'Hello there', '03:15 PM')
        ]
      },
      {
        type: 'messageChunk',
        isReplay: false,
        messages: [
          message('Author 4', '[en] hello there', '03:18 PM'),
          message('Author 3', '[es] hola allí', '03:17 PM')
        ]
      },
      {
        type: 'messageChunk',
        isReplay: false,
        messages: [message('Author 5', 'hello again', '03:19 PM')]
      }
    ];
  }

  async start() {
    for (const data of this.events) {
      for (const sub of this.subs) {
        await sub({ data });
      }
    }
  }

  addEventListener(_eventType, cb) {
    this.subs.push(cb);
  }
}
