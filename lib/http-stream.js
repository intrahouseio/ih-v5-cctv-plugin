const EventEmitter = require('events');
const url = require('url');
const crypto = require('crypto');
const http = require('http');

const TIMEOUT_CHECK_INTERVAL = 1000 * 5;
const CONNECT_TIMEOUT = 1000 * 19;
const KEEP_ALIVE_TIMEOUT = 2400;

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
    path: parse.path,
    login,
    pass,
   }
}

function md5(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

function digestAuthen(method, uri = '', realm = '', nonce = '', qop = null, username, password) {

  let HA1 = '';
  let HA2 = '';
  let RESPONSE = '';
  let text = '';

  HA1 = md5(`${username}:${realm}:${password}`);

  if (qop === null || qop === 'auth') {
    HA2 = md5(`${method}:${uri}`);
  }
  if (qop === 'auth-int') {
    HA2 = md5(`${method}:${uri}`);
  }

  if (qop === null) {
    RESPONSE = md5(`${HA1}:${nonce}:${HA2}`);
    text = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${RESPONSE}"`
  } else {
    RESPONSE = md5(`${HA1}:${nonce}:${'00000001'}:${'aa15f32757324670a22227173a46d6cc'}:${qop}:${HA2}`);
    text = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=${qop}, response="${RESPONSE}", nc=00000001, cnonce="aa15f32757324670a22227173a46d6cc"`
  }

  return text;
}

const BEGIN = Buffer.from('0d0a0d0affd8', 'hex');
const END = Buffer.from('ffd90d0a', 'hex');


class HttpStream extends EventEmitter {

  constructor(options) {
    super();

    this.id = options.id;
    this.type = options.protocol;
    this.transport = options.transport;

    this.parse = parseUrl(options.url);

    this.url = this.parse.url;
    this.login = this.parse.login;
    this.pass = this.parse.pass;

    this.url_original = options.url;

    this.err = 0;
    this.s = 0;
    this.timer = null;
    this.activity = Date.now();
    this.sres = null;

    this.ok = false;
    this.begin = 1;
    this.end = 0;
    this.l = 0;
    this.buf = null;

    this.i = 1;
    this.start()
  }

  req() {
    http
    .get(this.url_original, (res1) => {
      if (res1.statusCode === 200) {
        this.stream(res1);
      } else {
        if (res1.headers['www-authenticate'] !== undefined) {
          const options = url.parse(this.url);
          const temp = res1.headers['www-authenticate'].replace(/"/gi, '').split(', ');
          const params = {};
          temp.forEach(i => {
            const temp2 = i.split('=');
            if (temp2.length === 2) {
              params[temp2[0].toLowerCase()] = temp2[1]
            }
          });
          const authorization = digestAuthen('GET', this.parse.path, params.realm, params.nonce, params['digest qop'], this.login, this.pass);
          options.headers = { authorization };
          http
            .get(options, (res2) => {
              if (res2.statusCode === 200) {
                this.stream(res2);
              } else {
                this.emit('error', { id: this.id, msg: res2.statusMessage });
              }
            })
            .on('error', function(e) {
              this.emit('error', { id: this.id, msg: e.message });
            });
        } else {
          this.emit('error', { id: this.id, msg: res1.statusMessage });
        }
      }
    }).on('error', function(e) {
      this.emit('error', { id: this.id, msg: e.message });
    });
  }

  stream(res) {
    this.sres = res;
    if (res.headers['content-type'] !== undefined) {
      const temp = res.headers['content-type'].split('boundary=');
      if (temp.length === 2) {
        res.on('data', (data) => {
          if (this.buf !== null) {
            this.buf.push(data);
            data = Buffer.concat(this.buf)
            this.buf = null;
          }

          if (this.end) {
            const ie = data.indexOf(END, this.l);
            if (ie !== -1) {
              this.end = 2;
              const temp1 = data.slice(0, ie + 2);
              const temp2 = data.slice(ie + 4);
              if (this.s === 0) {
                this.s = 1;
                this.ok = true;
                this.emit('play', { id: this.id, rawdata: [] });
              }
              this.activity = Date.now();
              this.emit('stream', { id: this.id, data: temp1 });
              if (temp.length !== 0) {
                this.buf = [temp2];
              } else {
                this.buf = null;
              }
            } else {
              this.l = data.length;
              if (this.buf === null) {
                this.buf = [data];
              } else {
                this.buf.push(data);
              }
            }
          }

          if (this.begin) {
            const ib = data.indexOf(BEGIN);
            if (ib !== -1) {
              this.begin = 0;
              this.end = 1;
              this.l = 0
              const temp = data.slice(ib + 4);
              if (temp.length !== 0) {
                this.buf = [temp];
              }
            } else {
              if (this.buf === null) {
                this.buf = [data];
              } else {
                this.buf.push(data);
              }
            }
          }

          if (this.end === 2) {
            this.begin = 1;
            this.end = 0;
            this.l = 0
          }
        });

        res.on('end', () => {
          this.emit('error', { id: this.id, msg: 'stream close'});
        });
      } else {
        this.emit('error', { id: this.id, msg: 'boundary failed' });
      }
    } else {
      this.emit('error', { id: this.id, msg: 'content-type failed' });
    }
  }

  destroy() {
    clearInterval(this.timer);

    if (this.sres !== null) {
      this.sres.socket.destroy()
    }
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

module.exports = HttpStream;
