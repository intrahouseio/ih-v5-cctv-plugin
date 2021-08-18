const EventEmitter = require('events');
const crypto = require('crypto');
const net = require('net');
const dgram = require('dgram');
const fs = require('fs');
const url = require('url');

function parseParams(text) {
  if (text.indexOf('=') !== -1 && text.indexOf(',') !== -1) {
    const temp = {};
    const parse = text.replace(/\"/gi, '').split(',');
    parse.forEach(row => {
      const item = row.trim().split('=');
      if (item.length === 2) {
        const key = item[0].replace(/ /gi, '')
        temp[key.toLowerCase()] = item[1];
      }
    });
    return temp;
  }
  if (text.indexOf('=') !== -1 && text.indexOf(';') !== -1) {
    const temp = {};
    const parse = text.replace(/\"/gi, '').split(';');
    parse.forEach(row => {
      const item = row.split('=');
      if (item.length === 2) {
        const key = item[0].replace(/ /gi, '')
        temp[key.toLowerCase()] = item[1];
      }
      if (item.length === 1 && temp['value'] === undefined) {
        temp['value'] = item[0].replace(/ /gi, '')
      }
    });
    return temp;
  }

  return text;
}

function parseHeaders(text) {
  const temp = {
    code: null,
    status: null,
    version: null,
  };
  if (text !== undefined) {
    const parse = text.split('\r\n');
    if (parse.length !== 0) {
      parse.forEach(row => {
        const item = row.split(': ');
        if (item.length === 1) {
          const i = item[0].split(' ');
          if (i.length >= 3) {
            temp['version'] = i[0];
            temp['code'] = i[1];
            temp['status'] = i[2];
          }
        }
        if (item.length === 2) {
          const key = item[0].toLowerCase();
          if (temp[key]) {
            temp[key + '2'] = parseParams(item[1]);
          } else {
            temp[key] = parseParams(item[1]);
          }
        }
      });
    }
  }
  return temp;
}

function parseBody(text) {
  if (text !== undefined) {
    return text.split('\r\n')
  }
  return [];
}

function parse(text) {
  const parse = text.split('\r\n\r\n');

  return { headers: parseHeaders(parse[0]), body: parseBody(parse[1])  };
}

function checkrawdata(data) {
  const text = String(data);

  const index = text.indexOf('m=audio');
  if (index !== -1) {
    const temp = text.split('\r\n\r\n');
    if (temp.length >= 2) {
      const l = temp[1].length;
      const index2 = temp[1].indexOf('m=audio');
      if (index2 !== -1) {
        const temp2 = temp[1].slice(0, index2) + '\r\n';
        const temp3 = temp[0].replace(`ength: ${l}`, `ength: ${temp2.length}`);
        return temp3 + '\r\n\r\n' + temp2;
      }
    }
  }
  return text;
}

function parseUrl(string) {
  const parse = url.parse(string)
  const host = parse.hostname;
  const port = Number(parse.port) || 554;

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

class Rtsp extends EventEmitter {

  constructor(options) {
    super();

    this.id = options.id;
    this.type = options.protocol;
    this.transport = options.transport;
    this.codec = options.type;
    this.parse = parseUrl(options.url);

    this.cseq = 2;
    this.pversion = 'RTSP/1.0';
    this.useragent = 'ih-cctv (intraHouse plugin cctv)';

    this.host = this.parse.host;
    this.port = this.parse.port;

    this.url = this.parse.url;
    this.login = this.parse.login;
    this.pass = this.parse.pass;

    this.get_parameter = 0;
    this.mpacket = false;
    this.auth = false;
    this.method = ''
    this.buf = null;
    this.timer = null;
    this.ok = false;
    this.timer2 = null;
    this.rawdata = [];
    this.rawdata_mode = 0;
    this.uri = '';
    this.digestrealm = '';
    this.nonce = '';
    this.udpport1 = '';
    this.udpport2 = '';
    this.pps = null;
    this.seqn = Buffer.from([0, 0]);
    this.sssrc = crypto.randomBytes(4);

    this.activity = Date.now();

    this.client = new net.Socket();

    this.client.on('data', this.message.bind(this));
    this.client.on('error', this.error.bind(this));
    this.client.on('close', this.close.bind(this));

    this.udpserver = dgram.createSocket('udp4');
    this.udpserver.on('message', this.udpserver_message.bind(this));
    this.udpserver.on('error', this.udpserver_error.bind(this));
    this.udpserver.on('listening', this.udpserver_listening.bind(this));

    this.start();
  }

  destroy() {
    clearInterval(this.timer);
    clearInterval(this.time2);

    this.send(this.packet_teardown());

    this.client.end();
    this.client.destroy();

    if (this.type === 'udp') {
      this.udpserver.close();
    }
  }

  udpserver_message(data) {
    this.activity = Date.now();
    if (this.ok === false) {
      this.ok = true;
    }
    this.check_pps(this.id, data);
  }

  udpserver_error() {

  }

  udpserver_listening() {
    const address = this.udpserver.address();
    this.udpport1 = address.port;
    this.udpport2 = address.port + 1;
    this.send(this.packet_setup_udp());
  }

  replace_pps(old_pps, new_pps) {
    this.rawdata = this.rawdata
    .map(i => i.replace(
      Buffer.from(old_pps, 'hex').toString('base64'),
      Buffer.from(new_pps, 'hex').toString('base64'))
    );
  }

  send_rr(data) {
    const h = Buffer.from('2401004081c90007', 'hex');
    const ssrc_id = data.slice(4, 8);
    const ssrc_content = Buffer.from('00ffffff', 'hex');
    const sncc = Buffer.from('0001', 'hex');
    const jitter = Buffer.from('000000ff', 'hex');
    const lt = data.slice(8, 12);
    const dt = Buffer.from('000000ff', 'hex');
    const e1 = Buffer.from('81ca0007', 'hex');
    const e2 = Buffer.from('011269682d6363747620696e747261686f75736500000000', 'hex');

    const temp = Buffer.concat([h, this.sssrc, ssrc_id, ssrc_content, sncc, this.seqn, jitter, lt, dt, e1, this.sssrc, e2 ]);

    this.emit('debug', { id: this.id, msg: 'rtcp receiver report' });
    this.send_raw(temp);
  }

  check_pps(id, data) {
    const type = data[12] & 0x1F;

    if (this.rawdata_mode === 1) {
      if (type === 8) {
        const pps = data.slice(12).toString('hex');
        if (this.pps !== pps) {
          this.rawdata_mode = 3;
          this.emit('close', { id: this.id, msg: 'PPS has changed!' });
        }
      }
    }

    if (this.rawdata_mode === 0) {
      if (type === 8) {
        const pps = data.slice(12).toString('hex');
        if (this.pps === pps) {
          this.rawdata_mode = 1;
          this.emit('play', { id: this.id, rawdata: this.rawdata });
        } else {
          this.replace_pps(this.pps, pps);
          this.pps = pps;
          this.rawdata_mode = 1;
          this.emit('play', { id: this.id, rawdata: this.rawdata });
        }
      }
    }

    if (data[1] === 200) {
      this.emit('debug', { id: this.id, msg: 'rtcp sender report' });
      this.send_rr(data);
    } else {
      this.seqn = data.slice(2, 4);
      if (this.ok === false) {
        this.activity = Date.now();
        this.ok = true;
      }
      this.emit('stream', { id, data });
    }
  }

  tcpserver_message(data) {
    if (this.buf !== null) {
      this.buf.push(data);
      data = Buffer.concat(this.buf)
      this.buf = null;
    }

    // console.log(String(data.slice(0, 4)), data.slice(0, 25))

    if (data.length > 4 && data.readUInt16BE(2) + 4 <= data.length) {
      const l = data.readUInt16BE(2) + 4;

      if (data[4] === 160) {
        this.check_pps(this.id, data.slice(4, l - data[l - 1]));
      } else {
        this.check_pps(this.id, data.slice(4, l));
      }
      if (l !== data.length) {
        this.message(data.slice(l));
      }
    } else {
      if (this.buf === null) {
        this.buf = [data];
      } else {
        this.buf.push(data);
      }
    }
  }

  getAuth() {
    if (this.auth && this.login !== '') {
      if (this.digestrealm === '' && this.nonce === '') {
        const a = Buffer.from(`${this.login}:${this.pass}`).toString('base64');
        return 'Authorization: Basic ' + a + '\r\n';
      } else {
        const a = crypto.createHash('md5').update(`${this.login}:${this.digestrealm}:${this.pass}`).digest("hex");
        const b = crypto.createHash('md5').update(`${this.method}:${this.url}`).digest("hex");
        const c = crypto.createHash('md5').update(`${a}:${this.nonce}:${b}`).digest("hex");
        const d = `Digest username="${this.login}", realm="${this.digestrealm}", nonce="${this.nonce}", uri="${this.url}", response="${c}"`;
        return 'Authorization: ' + d + '\r\n';
      }
    }
    return '';
  }

  packet_options() {
    this.method = 'OPTIONS';
    return `${this.method} ${this.url} ${this.pversion}\r\n` +
           `CSeq: ${this.cseq}\r\n` +
           this.getAuth() +
           `User-Agent: ${this.useragent}`
  }

  packet_describe() {
    this.method = 'DESCRIBE';
    return `${this.method} ${this.url} ${this.pversion}\r\n` +
           `CSeq: ${this.cseq}\r\n` +
           `User-Agent: ${this.useragent}\r\n` +
            this.getAuth() +
           'Accept: application/sdp'
  }

  packet_setup_tcp() {
    this.method = 'SETUP';
    return `${this.method} ${this.url}${this.uri} ${this.pversion}\r\n` +
           `CSeq: ${this.cseq}\r\n` +
           `User-Agent: ${this.useragent}\r\n` +
            this.getAuth() +
           'Transport: RTP/AVP/TCP;unicast;interleaved=0-1'
  }

  packet_setup_udp() {
    this.method = 'SETUP';
    return `${this.method} ${this.url}${this.uri} ${this.pversion}\r\n` +
           `CSeq: ${this.cseq}\r\n` +
           `User-Agent: ${this.useragent}\r\n` +
            this.getAuth() +
           `Transport: RTP/AVP;unicast;client_port=${this.udpport1}-${this.udpport2}`
  }

  packet_play() {
    this.method = 'PLAY';
    return `${this.method} ${this.url} ${this.pversion}\r\n` +
           `CSeq: ${this.cseq}\r\n` +
           `User-Agent: ${this.useragent}\r\n` +
            this.getAuth() +
           `Session: ${this.session}\r\n` +
           'Range: npt=0.000-'
  }

  packet_get_parameter() {
    this.method = 'GET_PARAMETER';
    return `${this.method} ${this.url} ${this.pversion}\r\n` +
           `CSeq: ${this.cseq}\r\n` +
           `User-Agent: ${this.useragent}\r\n` +
            this.getAuth() +
           `Session: ${this.session}`
  }

  packet_teardown() {
    this.method = 'TEARDOWN';
    return `${this.method} ${this.url} ${this.pversion}\r\n` +
           `CSeq: ${this.cseq}\r\n` +
           `User-Agent: ${this.useragent}\r\n` +
            this.getAuth() +
           `Session: ${this.session}`
  }

  responseOK(msg) {
    if (this.method === 'GET_PARAMETER') {

    }

    if (this.method === 'PLAY') {
      if (this.codec !== 'rtsp/h264') {
        this.rawdata_mode = 3;
        this.emit('play', { id: this.id, rawdata: this.rawdata });
      }
      this.emit('debug', { id: this.id, msg: 'rtsp play' });
      this.checkStream()
    }

    if (this.method === 'SETUP') {

      if (msg.headers['session'] !== undefined) {
        if (msg.headers['session']['value']) {
          this.session = msg.headers['session']['value'];
        } else {
          this.session = msg.headers['session'];
        }
      }
      this.send(this.packet_play());
    }

    if (this.method === 'DESCRIBE') {
      let check = false;

      msg.body.forEach(i => {

        const mv = i.indexOf('m=video');
        const ma = i.indexOf('m=audio');
        const sps = i.indexOf('sprop-parameter-sets=');
        if (sps !== -1) {
          this.pps = Buffer.from(i.slice(sps).split(',')[1], 'base64').toString('hex');
        }

        if (mv !== -1) {
          check = true;
        }
        if (ma !== -1) {
          check = false;
        }
        if (check) {
          const ac = i.indexOf('a=control:');
          if (ac !== -1) {
            this.uri = i.slice(10 + ac)
            // if (this.url[this.url.length - 1] !== '/' && this.uri[0] !== '/') {
            // this.uri = '/' + this.uri; 
            // }
            check = false;
          }
        }
      })
      if (msg.headers['content-base'] !== undefined) {
        this.url = msg.headers['content-base'];
      }
      if (this.type === 'udp') {
        this.udpserver.bind();
      } else {
        this.send(this.packet_setup_tcp())
      }
    }

    if (this.method === 'OPTIONS') {
      if (msg.headers.public !== undefined) {
        if (msg.headers.public.indexOf('GET_PARAMETER') !== -1) {
          this.get_parameter = 1;
        }
      }
      this.send(this.packet_describe());
    }
  }

  responseError(msg) {
    if (this.method === 'DESCRIBE' && this.auth === true && msg.headers.code === '401') {
      this.emit('error', { id: this.id, msg: 'fail auth' });
    }

    if ((this.method === 'OPTIONS' || this.method === 'DESCRIBE') && this.auth === false && msg.headers.code === '401') {
      if (msg.headers['www-authenticate']) {
        if (msg.headers['www-authenticate']['digestrealm'] && msg.headers['www-authenticate']['digestrealm'] !== '') {
          this.digestrealm = msg.headers['www-authenticate']['digestrealm'];
        }
        if (msg.headers['www-authenticate']['nonce'] && msg.headers['www-authenticate']['nonce'] !== '') {
          this.nonce = msg.headers['www-authenticate']['nonce'];
        }
      }
      this.auth = true;
      if (this.method === 'OPTIONS') {
        this.send(this.packet_options());
      } else {
        this.send(this.packet_describe());
      }
      this.emit('debug', { id: this.id, msg: 'need auth' });
    }

    if (msg.headers.code !== '401') {
      const text = msg.headers.status.toLowerCase ? msg.headers.status.toLowerCase() : msg.headers.status;
      this.emit('error', { id: this.id, msg: text });
    }
  }

  close() {
    // console.log('close')
  }

  error(e) {
    // console.log('error')
  }

  send(data) {
    if (this.client.readyState === 'open') {
      this.client.write(data + '\r\n\r\n');
      this.cseq++;
    }
  }

  send_raw(data) {
    if (this.client.readyState === 'open') {
      this.client.write(data);
    }
  }

  open() {
    this.send(this.packet_options());
  }

  message(data) {
    this.activity = Date.now();

    if (data.length >= 4) {
      if (data[0] === 82 && data[1] === 84 && data[2] === 83 && data[3] === 80) {
        const msg = parse(String(data));
        if (msg.headers.code === '200') {
          this.rawdata.push(checkrawdata(data))
          this.responseOK(msg);
        } else {
          this.responseError(msg);
        }
      } else if (this.type === 'tcp') {
        this.tcpserver_message(data)
      }
    } else {
      this.tcpserver_message(data)
    }
  }

  checkStream() {
    if (this.get_parameter === 1) {
      this.send(this.packet_get_parameter());
      this.timer2 = setInterval(() => {
        this.send(this.packet_get_parameter());
      }, 1000 * 20);
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
    this.client.connect(this.port, this.host, this.open.bind(this));
    this.timer = setInterval(this.check.bind(this), TIMEOUT_CHECK_INTERVAL)
    this.activity = Date.now();
  }
}

module.exports = Rtsp;
