const EventEmitter = require('events');
const request = require('request');
const url = require('url');

function parseUrl(string) {
  const parse = url.parse(string)
  const host = parse.hostname;
  const port = Number(parse.port) || 80;

  let login = '';
  let pass = '';

  if (parse.auth) {
    const temp = parse.auth.split(':');
    if (temp.length === 2) {
      login = temp[0];
      pass = temp[1];
    } else {
      login = temp[0];
      pass = '';
    }
  }

  return {
    host,
    port,
    url: `${parse.protocol}//${host}:${port}${parse.path}`,
    login,
    pass,
   }
}

const TIMEOUT_CHECK_INTERVAL = 1000 * 5;
const CONNECT_TIMEOUT = 1000 * 19;
const KEEP_ALIVE_TIMEOUT = 2400;

class Snapshot extends EventEmitter {

  constructor(options) {
    super();

    this.id = options.id;
    this.type = options.protocol;
    this.transport = options.transport;

    this.parse = parseUrl(options.url);

    this.url = this.parse.url;
    this.login = this.parse.login;
    this.pass = this.parse.pass;

    this.settings = { uri: options.url, encoding: null }

    this.ok = false;
    this.err = 0;
    this.s = 0;

    this.stop = false;

    this.activity = Date.now();

    this._res = this.res.bind(this);

    this.start()
  }

  req() {
    request(this.settings , this._res);
  }

  res(error, response, body) {
    if (error === null && response.statusCode === 200) {
      if (this.s === 0) {
        this.s = 1;
        this.ok = true;
        if (this.stop === false) {
          this.emit('play', { id: this.id, rawdata: [] });
        }
      }
      this.activity = Date.now();

      if (this.stop === false) {
        this.emit('stream', { id: this.id, data: body });
        this.req();
      }

    } else {
      if (this.err === 0) {
        this.err = 1;
        this.settings = {
          uri: this.url,
          encoding: null,
          auth: {
            user: this.login,
            pass: this.pass,
            sendImmediately: false
          }
        };
        if (this.stop === false) {
          this.req();
        }
      } else {
        this.emit('error', { id: this.id, msg: response.statusMessage });
      }
    }
  }

  destroy() {
      this.stop = true;
      clearInterval(this.timer);
  }

  check() {
    if (this.ok) {
      const interval = Date.now() - this.activity;
      if (interval >= KEEP_ALIVE_TIMEOUT) {
        clearInterval(this.timer);
        this.emit('close', { id: this.id, msg: 'timeout' });
      }
    } else {
      const interval = Date.now() - this.activity;
      if (interval >= CONNECT_TIMEOUT) {
        clearInterval(this.timer);
        this.emit('close', { id: this.id, msg: 'timeout' });
      }
    }
  }

  start() {
    this.timer = setInterval(this.check.bind(this), TIMEOUT_CHECK_INTERVAL);
    this.activity = Date.now();
    this.req();
  }
}

module.exports = Snapshot;
