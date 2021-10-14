//const plugin = require('ih-plugin-api')();
const plugin = { log: console.log, params: { get: () => Promise.resolve({})} };

const udp = require('dgram')
const Peer = require('simple-peer');
const wrtc = require('wrtc');
const WebSocket = require('ws');
const fs = require('fs');

const logger = require('./lib/logger');

const Rtsp = require('./lib/rtsp');
const Snapshot = require('./lib/snapshot');
const HttpStream = require('./lib/http-stream');
const jpeg = require('./lib/jpeg');
const tools = require('./lib/tools');
const { Console } = require('console');


const STORE = {
  cams: { },
  channels: { ws: {}, p2p: {} },
  jpeg: {},
  check: {
    cams: {},
    ws: {},
    p2p: {},
  },
};

const config = { 
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] },
    {
      urls: 'turn:turn.ih-systems.com:47000',
      username: 'ihv5',
      credential: '136d2723b0ac',
    },
  ]
}

const SYSTEM_CHECK_INTERVAL = 1000 * 20;
const CHANNEL_CHECK_INTERVAL = 1000 * 10;

const SUB_TIMEOUT = 1000 * 120;
const WS_TIMEOUT = 1000 * 20;
const P2P_TIMEOUT = 1000 * 20;


function sendProcessInfo() {
  const mu = process.memoryUsage();
  const memrss = Math.floor(mu.rss / 1024);
  const memheap = Math.floor(mu.heapTotal / 1024);
  const memhuse = Math.floor(mu.heapUsed / 1024);

  const data = { memrss, memheap, memhuse };

  process.send({ type: 'procinfo', data });
}

function snapshot_jpeg({ id, data }) {
  send_channel({ id, data });
}

function rtsp_jpeg({ id, data }) {
  const t = data[16];
  const q = data[17];

  const reset = 64 <= t && t <= 127;
  const quant = 128  <= q && q <= 255;


  if (STORE.jpeg[id] === undefined) {
    STORE.jpeg[id] = { first: true, buffer: [], header: null };
  }

  if (STORE.jpeg[id].first === true) {
    if (STORE.jpeg[id].header === null) {
      STORE.jpeg[id].header = tools.genJpegHeader(reset, quant, data)
    }

    STORE.jpeg[id].buffer.push(STORE.jpeg[id].header);
  }

  STORE.jpeg[id].buffer.push(tools.sliceJpegData(reset, STORE.jpeg[id].first && quant, data))

  if (STORE.jpeg[id].first === true) {
    STORE.jpeg[id].first = false;
  }

  if (data[1] === 154) {
    send_channel({ id, data: Buffer.concat(STORE.jpeg[id].buffer) });
    STORE.jpeg[id].buffer = [];
    STORE.jpeg[id].first = true;
  }
}

function rtsp_stream({ id, data }) {
  // const type = data[12] & 0x1F;
  // const nri = data[12] & 0x60;
  // const is_start = (data[13] & 0x80) >>> 7;
  // const is_end = (data[13] & 0x40) >>> 6;
  // const payload_type = data[13] & 0x1F;

  // plugin.log( type, nri, payload_type, is_start, is_end, data.slice(0, 25))

  send_channel({ id, data });

}

function send_channel({ id, data }) {
  if (STORE.cams[id] !== undefined) {
      if (STORE.cams[id].config.transport === 'ws') {
        STORE.cams[id].subs
          .forEach(channelid => {
            if (STORE.channels.ws[channelid] !== undefined && STORE.channels.ws[channelid].socket.readyState === 1) {
              const temp = Buffer.concat([Buffer.from([4, 0, 0, 0, 0, 0, 0]), data]);
              temp.writeUInt16BE(Number(id), 1)
              STORE.channels.ws[channelid].socket.send(temp);
            }
        });
      }
      if (STORE.cams[id].config.transport === 'p2p') {
        STORE.cams[id].subs
          .forEach(channelid => {
            if (STORE.channels.p2p[channelid] !== undefined && STORE.channels.p2p[channelid].socket.connected) {
              const temp = Buffer.concat([Buffer.from([4, 0, 0, 0, 0, 0, 0]), data]);
              temp.writeUInt16BE(Number(id), 1)
              STORE.channels.p2p[channelid].socket.send(temp);
            }
        });
      }
  }
}

function rtsp_play({ id, rawdata }) {
  if (STORE.cams[id] !== undefined) {
    STORE.cams[id].rawdata = rawdata;
  }
  STORE.cams[id].subs
    .forEach(channelid => {
      transferdata(channelid, { method: 'rtsp_ok', params: { camid: id, rawdata } });
    });
}

function rtsp_close({ id, msg }) {
  plugin.log(`cam: ${id}, Close -> ${msg}`,2);
  unsub_cam(id, true);
}

function snapshot_play({ id, rawdata }) {
  if (STORE.cams[id] !== undefined) {
    STORE.cams[id].rawdata = rawdata;
  }
  STORE.cams[id].subs
    .forEach(channelid => {
      transferdata(channelid, { method: 'rtsp_ok', params: { camid: id, rawdata } });
    });
}

function snapshot_close({ id, msg }) {
  plugin.log(`cam: ${id}, Close -> ${msg}`,2);
  unsub_cam(id, true);
}

function cam_debug({ id, msg }) {
  plugin.log(`cam ${id}: Normal -> ${msg}`,2);
}

function cam_error({ id, msg }) {
  plugin.log(`cam ${id}: Error -> ${msg}`,2);
  if (STORE.cams[id] !== undefined) {
    STORE.cams[id].subs
      .forEach(tid => {
        transferdata(tid, { method: 'cam_error', params: { camid: id, msg } });
      });
  }
}

function create_cam(id, config) {
  switch (config.type) {
    case 'rtsp/h264':
        STORE.cams[config.id].rtsp = new Rtsp(config);
        STORE.cams[config.id].rtsp.on('play', rtsp_play);
        STORE.cams[config.id].rtsp.on('stream', rtsp_stream);
        STORE.cams[config.id].rtsp.on('close', rtsp_close);
        STORE.cams[config.id].rtsp.on('debug', cam_debug);
        STORE.cams[config.id].rtsp.on('error', cam_error);
      break;
    case 'rtsp/mjpeg':
        STORE.cams[config.id].rtsp = new Rtsp(config);
        STORE.cams[config.id].rtsp.on('play', rtsp_play);
        STORE.cams[config.id].rtsp.on('stream', rtsp_jpeg);
        STORE.cams[config.id].rtsp.on('close', rtsp_close);
        STORE.cams[config.id].rtsp.on('debug', cam_debug);
        STORE.cams[config.id].rtsp.on('error', cam_error);
      break;
    case 'http/jpeg':
        STORE.cams[config.id].snap = new Snapshot(config);
        STORE.cams[config.id].snap.on('play', snapshot_play);
        STORE.cams[config.id].snap.on('close', snapshot_close);
        STORE.cams[config.id].snap.on('stream', snapshot_jpeg);
        STORE.cams[config.id].snap.on('debug', cam_debug);
        STORE.cams[config.id].snap.on('error', cam_error);
      break;
    case 'http/mjpeg':
        STORE.cams[config.id].snap = new HttpStream(config);
        STORE.cams[config.id].snap.on('play', snapshot_play);
        STORE.cams[config.id].snap.on('close', snapshot_close);
        STORE.cams[config.id].snap.on('stream', snapshot_jpeg);
        STORE.cams[config.id].snap.on('debug', cam_debug);
        STORE.cams[config.id].snap.on('error', cam_error);
      break;
    default:
      break;
  }
}

function checkchannel(type, channelid) {
  if (type === 'ws') {
    if (STORE.channels.ws[channelid] !== undefined && STORE.channels.ws[channelid].socket.readyState === 1) {
      STORE.channels.ws[channelid].socket.send(Buffer.concat([Buffer.from([1, 0, 0]), Buffer.from(channelid, 'utf8')]));
    }
  }
  if (type === 'p2p') {
    if (STORE.channels.p2p[channelid] !== undefined && STORE.channels.p2p[channelid].socket.connected) {
      STORE.channels.p2p[channelid].socket.send(Buffer.concat([Buffer.from([1, 0, 0]), Buffer.from(channelid, 'utf8')]));
    }
  }
}

function channelp2p(channelid) {
  plugin.log(`createchannel_p2p: ${channelid}`,2);
  if (STORE.channels.p2p[channelid] === undefined) {
    STORE.channels.p2p[channelid] = {
      socket: new Peer({ config, wrtc: wrtc }),
      activity: Date.now(),
      state: 0,
    };
    STORE.channels.p2p[channelid].socket.on('signal', (data) => p2p_signal(channelid, data));
    STORE.channels.p2p[channelid].socket.on('connect', p2p_connect);
    STORE.channels.p2p[channelid].socket.on('data', p2p_data);
    STORE.channels.p2p[channelid].socket.on('error', p2p_error);
    STORE.channels.p2p[channelid].socket.on('close', (e) => p2p_close(STORE.channels.p2p[channelid], e));
  }
}

function registrationchannel(socket, type, channelid) {
  plugin.log(`registrationchannel: ${channelid}`,2);
  if (type === 'ws' && STORE.channels.ws[channelid] === undefined) {
    STORE.channels.ws[channelid] = {
      socket,
      activity: Date.now(),
      timer: setInterval(() => checkchannel(type, channelid), CHANNEL_CHECK_INTERVAL)
    };
  }
  if (type === 'p2p') {
    if (STORE.channels.p2p[channelid] !== undefined && STORE.channels.p2p[channelid].state === 0) {
      STORE.channels.p2p[channelid].state = 1;
      STORE.channels.p2p[channelid].activity = Date.now();
      STORE.channels.p2p[channelid].timer = setInterval(() => checkchannel(type, channelid), CHANNEL_CHECK_INTERVAL)
    }
  }
}

function removechannel(type, channelid) {
  plugin.log(`removechannel: ${channelid}`,2);
  if (type === 'ws') {
    Object
      .keys(STORE.cams)
      .forEach(camid => {
        if (STORE.cams[camid] !== undefined && STORE.cams[camid].subs) {
          STORE.cams[camid].subs = STORE.cams[camid].subs.filter(i => i !== channelid)
        }
      });

      if (STORE.channels.ws[channelid] !== undefined) {
        clearInterval(delete STORE.channels.ws[channelid].timer)
        STORE.channels.ws[channelid].socket.terminate();
        delete STORE.channels.ws[channelid];
      }

    if (STORE.check.ws[channelid] !== undefined) {
      delete STORE.check.ws[channelid]
    }
  }
  if (type === 'p2p') {
    Object
      .keys(STORE.cams)
      .forEach(camid => {
        if (STORE.cams[camid] !== undefined && STORE.cams[camid].subs) {
          STORE.cams[camid].subs = STORE.cams[camid].subs.filter(i => i !== channelid)
        }
      });

      if (STORE.channels.p2p[channelid] !== undefined) {
        clearInterval(delete STORE.channels.p2p[channelid].timer)
        STORE.channels.p2p[channelid].socket.destroy();
        delete STORE.channels.p2p[channelid];
      }

    if (STORE.check.p2p[channelid] !== undefined) {
      delete STORE.check.p2p[channelid]
    }
  }
}

function echochannel(type, channelid) {
  plugin.log(`echochannel: ${channelid}`,2);

  if (type === 'ws') {
    if (STORE.channels.ws[channelid] !== undefined) {
      STORE.channels.ws[channelid].activity = Date.now();
    }
  }

  if (type === 'p2p') {
    if (STORE.channels.p2p[channelid] !== undefined) {
      STORE.channels.p2p[channelid].activity = Date.now();
    }
  }
}

function sub_cam(id, data) {
  if (STORE.cams[data.params.id] === undefined) {
    plugin.log(`cam_sub: ${data.params.id} (${data.params.url})`,2);
    STORE.cams[data.params.id] = { config: data.params, rtsp: null, snap: null, subs: [] };
    STORE.cams[data.params.id].subs.push(id);
    create_cam(id, data.params)
    transferdata(id, { method: 'cam_ok', params: data.params });
  } else {
    transferdata(id, { method: 'cam_ok', params: data.params });
    if (STORE.cams[data.params.id].rawdata !== undefined) {
      transferdata(id, { method: 'rtsp_ok', params: { camid: data.params.id, rawdata: STORE.cams[data.params.id].rawdata } });
    }
    if (STORE.cams[data.params.id].subs.find(subid => subid === id) === undefined) {
      plugin.log(`cam_sub: ${data.params.id} (${data.params.url})`,2);
      STORE.cams[data.params.id].subs.push(id);
    }
  }
}

function unsub_cam(camid, notification) {
  plugin.log(`cam_unsub: ${camid}`,2);
  if (STORE.cams[camid] !== undefined) {

    if (notification) {
      STORE.cams[camid].subs
        .forEach(id => {
          transferdata(id, { method: 'cam_close', params: { camid } });
        });
    }

    switch (STORE.cams[camid].config.type) {
      case 'rtsp/mjpeg':
      case 'rtsp/h264':
        STORE.cams[camid].rtsp.destroy();
        break;
      case 'http/mjpeg':
      case 'http/jpeg':
        STORE.cams[camid].snap.destroy();
        break;
      default:
        break;
    }
    delete STORE.cams[camid];
  }

  if (STORE.check.cams[camid] !== undefined) {
    delete STORE.check.cams[camid];
  }
}

function close_cam(channelid, camid) {
  if (STORE.cams[camid] !== undefined && STORE.cams[camid].subs) {
    const index = STORE.cams[camid].subs.findIndex(i => i === channelid);
    if (index !== -1) {
      plugin.log(`cam_unsub: ${camid}`,2);
      STORE.cams[camid].subs.splice(index, 1)
    }
  }
}

function p2p_params(channelid, data) {
  if (STORE.channels.p2p[channelid] !== undefined) {
    STORE.channels.p2p[channelid].socket.signal(data.params);
  }
}

function p2p_signal(channelid, data) {
  transferdata(channelid, { method: 'p2p_params', params: data });
}

function p2p_connect() {
  plugin.log('p2p_connect',2);
}

function p2p_data(data) {
  switch (data[0]) {
    case 0:
      registrationchannel(null, 'p2p', data.slice(1).toString())
      break;
    case 2:
      echochannel('p2p', data.slice(3).toString())
      break;
    default:
      break;
  }
}

function p2p_error() {

}

function p2p_close(p2p) {
  if (p2p !== undefined) {
    Object
      .keys(STORE.channels.p2p)
      .forEach(key => {
        if (STORE.channels.p2p[key] !== undefined && STORE.channels.p2p[key].socket) {
          if (STORE.channels.p2p[key].socket === p2p.socket) {
            removechannel('p2p', key);
          }
        }
      })
  }
}

function ws_message(ws, data) {
  switch (data[0]) {
    case 0:
      registrationchannel(ws, 'ws', data.slice(1).toString())
      break;
    case 2:
      echochannel('ws', data.slice(3).toString())
      break;
    default:
      break;
  }
}

function ws_close(ws, e) {
  Object
    .keys(STORE.channels.ws)
    .forEach(key => {
      if (STORE.channels.ws[key] !== undefined && STORE.channels.ws[key].socket) {
        if (STORE.channels.ws[key].socket === ws) {
          removechannel('ws', key);
        }
      }
    })
}

function ws_connection(ws) {
  ws.on('message', data => ws_message(ws, data));
  ws.on('close', e => ws_close(ws, e));
}

function channel_settings(id, data) {
  if (data.params.type === 'ws') {
    const settings = {};
    transferdata(id, { method: 'channel_settings', params: { type: 'ws', port: settings.wsport || 8099 } });
  }
  if (data.params.type === 'p2p') {
    channelp2p(id);
    transferdata(id, { method: 'channel_settings', params: { type: 'p2p' } });
  }
}

function systemCheck() {
  const cams = Object.keys(STORE.cams);
  const ws = Object.keys(STORE.channels.ws);
  const p2p = Object.keys(STORE.channels.p2p);
  plugin.log('system activity check',2);
  plugin.log(`cams: ${cams.length}`,2);

  cams.forEach(key => {
    if (STORE.cams[key] !== undefined && STORE.cams[key].subs) {
      plugin.log(`cam ${key}: subs ${STORE.cams[key].subs.length}`,2);
      if (STORE.cams[key].subs.length === 0) {
        if (STORE.check.cams[key] === undefined) {
          STORE.check.cams[key] = 1;
        } else {
          STORE.check.cams[key] = STORE.check.cams[key] + 1;
        }
      } else {
        if (STORE.check.cams[key] !== undefined) {
          delete STORE.check.cams[key];
        }
      }
    }
  });

  plugin.log(`channels_ws: ${ws.length}`,2);

  ws.forEach(key => {
    if (STORE.channels.ws[key] !== undefined) {
      const interval = Date.now() - STORE.channels.ws[key].activity;
      if (interval >= WS_TIMEOUT) {
        STORE.check.ws[key] = true;
      }
    }
  });

  plugin.log(`channels_p2p: ${p2p.length}`,2);

  p2p.forEach(key => {
    if (STORE.channels.p2p[key] !== undefined) {
      const interval = Date.now() - STORE.channels.p2p[key].activity;
      if (interval >= WS_TIMEOUT) {
        STORE.check.p2p[key] = true;
      }
    }
  });

  plugin.log('---------------------------',2);
  plugin.log('',2);

  const tcams = Object.keys(STORE.check.cams);
  const tws = Object.keys(STORE.check.ws);
  const tp2p = Object.keys(STORE.check.p2p);

  plugin.log('system timeout check',2);
  plugin.log(`timeout subs: ${tcams.length}`,2);

  tcams.forEach(key => {
    if (STORE.check.cams[key] !== undefined) {
      const interval = STORE.check.cams[key] * SYSTEM_CHECK_INTERVAL;

      if (interval > SUB_TIMEOUT) {
        unsub_cam(key, false);
        delete STORE.check.cams[key];
      } else {
        plugin.log(`sub cam ${key}: timeout ${interval}`,2);
      }
    }
  });

  plugin.log(`timeout channels_ws: ${tws.length}`,2);
  tws.forEach(key => {
    if (STORE.check.ws[key] !== undefined) {
      removechannel('ws', key);
      delete STORE.check.ws[key]
    }
  });

  plugin.log(`timeout channels_p2p: ${tp2p.length}`,2);
  tp2p.forEach(key => {
    if (STORE.check.p2p[key] !== undefined) {
      removechannel('p2p', key);
      delete STORE.check.p2p[key]
    }
  });
  plugin.log('---------------------------',2);
  plugin.log('',2);

  plugin.log(`buffer channels_ws: ${Object.keys(STORE.channels.ws).length}`);
  Object.keys(STORE.channels.ws).forEach(key => {
    if (STORE.channels.ws[key] !== undefined && STORE.channels.ws[key].socket) {
      const size = (STORE.channels.ws[key].socket.bufferedAmount / 1024 / 1024).toFixed(2)
      plugin.log(`channel ${key}: ${size} mb`,2);
      if (size >= 40) {
        removechannel('ws', key);
      }
    }
  });
  plugin.log('---------------------------',2);
  plugin.log('',2);
}

process.on('message', msg => {
  if (typeof msg === 'object' && msg.type === 'transferdata' && msg.payload !== undefined) {
    const uuid = msg.uuid;
    const data = msg.payload;

    switch (data.method) {
      case 'create_channel':
        channel_settings(uuid, data);
        break;
      case 'sub_cam':
        sub_cam(uuid, data);
        break;
      case 'close_cam':
        close_cam(uuid, data.params.camid)
        break;
      case 'p2p_params':
        p2p_params(uuid, data);
        break;
      default:
        break;
    }
  }
});

/*
plugin.on('command', (command) => {
  if (command.type === 'snap') {
    const cam = plugin.channels.find(i => i.id === command.camid)
    if (cam !== undefined && cam.settings) {
      const snap = cam.settings.find(i => i.settings_type === 'snap');
      if (snap) {
        jpeg(snap.snap_url, snap.snap_timeout)
          .then((data) => {
            const path = `${plugin.system.tempdir}/snapshot/`;
            const filename = `snap_${Date.now()}.jpg`;
            try {
              fs.writeFileSync(path + filename, data);
              command.resolve({ filename: path + filename });
            } catch (e) {
              command.reject(e.message);
            }
          })
          .catch((msg) => command.reject(msg));
      } else {
        command.reject(`no snapshot option for camera ${command.camid}`)
      }
    } else {
      command.reject(`no snapshot option for camera ${command.camid}`)
    }
  }
});
*/

function transferdata(uuid, payload) {
  process.send({ 
    id: uuid, 
    uuid: uuid, 
    type: 'transferdata', 
    unit: 'cctv',
    payload, 
  });
}


async function main(options) {
  let opt;
  try {
    opt = JSON.parse(process.argv[2]);
  } catch (e) {
    opt = {};
  }

  const logfile = opt.logfile || path.join(__dirname, 'ih_cctv.log');
  const loglevel = opt.loglevel || 0;

  // logger.start(logfile, loglevel);
  plugin.log('Plugin cctv has started  with args: ' + process.argv[2]);

  const settings = await plugin.params.get();
  plugin.log(`transport WebSocket: ${settings.wsport || 8099}`)
  const wss = new WebSocket.Server({ port: settings.wsport || 8099 });
  wss.on('connection', ws_connection);

  // setInterval(systemCheck, SYSTEM_CHECK_INTERVAL);
  // setInterval(sendProcessInfo, 10000);

  sendProcessInfo();
}

main();

const s = `WyJSVFNQLzEuMCAyMDAgT0tcclxuQ1NlcTogM1xyXG5QdWJsaWM6IE9QVElPTlMsIERFU0NSSUJFLCBTRVRVUCwgUExBWSwgVEVBUkRPV04sIFBBVVNFLCBTRVRfUEFSQU1FVEVSLCBHRVRfUEFSQU1FVEVSXHJcbkRhdGU6IFRodSwgMTQgT2N0IDIwMjEgMTA6NDY6MTUgR01UXHJcblxyXG4iLCJSVFNQLzEuMCAyMDAgT0tcclxuQ1NlcTogNFxyXG5Db250ZW50LVR5cGU6IGFwcGxpY2F0aW9uL3NkcFxyXG5Db250ZW50LUxlbmd0aDogNTc3XHJcbkRhdGU6IFRodSwgMTQgT2N0IDIwMjEgMTA6NDY6MTUgR01UXHJcblxyXG52PTBcclxubz0tIDExMDkxNjIwMTQyMTkxODIgMCBJTiBJUDQgMC4wLjAuMFxyXG5zPUhJSyBNZWRpYSBTZXJ2ZXIgVjMuNC4xMDFcclxuaT1ISUsgTWVkaWEgU2VydmVyIFNlc3Npb24gRGVzY3JpcHRpb24gOiBzdGFuZGFyZFxyXG5lPU5PTkVcclxuYz1JTiBJUDQgMC4wLjAuMFxyXG50PTAgMFxyXG5hPWNvbnRyb2w6KlxyXG5iPUFTOjMwODJcclxuYT1yYW5nZTpucHQ9bm93LVxyXG5tPXZpZGVvIDAgUlRQL0FWUCA5NlxyXG5pPVZpZGVvIE1lZGlhXHJcbmE9cnRwbWFwOjk2IEgyNjQvOTAwMDBcclxuYT1mbXRwOjk2IHByb2ZpbGUtbGV2ZWwtaWQ9NEQwMDE0O3BhY2tldGl6YXRpb24tbW9kZT0wO3Nwcm9wLXBhcmFtZXRlci1zZXRzPVowMUFIbzJOUUZBZS8vK0FQd0F2dHdFQkFVQUFBUG9BQUREVU9oZ0I2Y0FBSmlXcnZMalF3QTlPQUFFeExWM2x3b0E9LGFPNDRnQT09XHJcbmE9Y29udHJvbDp0cmFja0lEPXZpZGVvXHJcbmI9QVM6MzA3MlxyXG5hPU1lZGlhX2hlYWRlcjpNRURJQUlORk89NDk0RDRCNDgwMjAxMDAwMDA0MDAwMDAxMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA7XHJcbmE9YXBwdmVyc2lvbjoxLjBcclxuIiwiUlRTUC8xLjAgMjAwIE9LXHJcblNlc3Npb246IDE1NjUyNzU0NDE7dGltZW91dD02MFxyXG5UcmFuc3BvcnQ6IFJUUC9BVlAvVENQO3VuaWNhc3Q7aW50ZXJsZWF2ZWQ9MC0xO3NzcmM9NWQ0YzM1MzFcclxuQ1NlcTogNVxyXG5BY2NlcHQtUmFuZ2VzOiBOUFRcclxuTWVkaWEtUHJvcGVydGllczogTm8tU2Vla2luZywgVGltZS1Qcm9ncmVzc2luZywgVGltZS1EdXJhdGlvbj0wXHJcbkRhdGU6IFRodSwgMTQgT2N0IDIwMjEgMTA6NDY6MTUgR01UXHJcblxyXG4iLCJSVFNQLzEuMCAyMDAgT0tcclxuU2Vzc2lvbjogMTU2NTI3NTQ0MVxyXG5DU2VxOiA2XHJcbkRhdGU6IFRodSwgMTQgT2N0IDIwMjEgMTA6NDY6MTUgR01UXHJcblxyXG4kXHUwMDAwXHUwMDAw77+977+977+9Mlx1MDAxYu+/ve+/ve+/vUZdTDUxYe+/vVx1MDAwNVx1MDAwMFxuXHUwMDA1cVx1MDAxZnRu77+977+977+977+9bCjvv71cdTAwMWPvv704WTRw77+9MO+/ve+/ve+/vXfvv71zOO+/vW1cdTAwMTbejO+/vURcdTAwMDRcdTAwMWJ7WVx1MDAwYu+/vdKBTX7vv71cdTAwMDfvv73vv73vv73vv73vv73vv73vv73vv713bVx1MDAxZnjvv70yPEvvv71cdTAwMWXvv71cdTAwMDFVQHbvv71077+977+9ae+/vUxE77+9S1x1MDAwNu+/ve+/vWp177+9UO+/ve+/vVwicmzvv73vv714O++/vVx1MDAxYVxc77+977+9bO+/vdi9XHUwMDE577+9f++/vT8277+9Ku+/vTrvv70477+9X++/ve+/ve+/ve+/vdqF77+9WzI1xp7vv70rU++/ve+/ve+/ve+/ve+/vTbvv71077+977+9c1x1MDAxOFx1MDAwMErvv70w77+9XHUwMDAwXHUwMDAwXHUwMDAzIiwiUlRTUC8xLjAgMjAwIE9LXHJcbkNTZXE6IDdcclxuRGF0ZTogVGh1LCAxNCBPY3QgMjAyMSAxMDo0NjoxNSBHTVRcclxuXHJcbiRcdTAwMDBcdTAwMDDvv73vv73vv70yXHUwMDFl77+977+977+9dl1MNTFh77+9XHUwMDA1YFxu77+9cVx1MDAxZnIvXFxcYjZjaTNhcmlcZu+/ve+/vXo277+9XFzvv73vv71cdTAwMTjLve+/vWjvv71vau+/vWda77+9aEk8N3VqXHUwMDAwUnU/L++/ve+/vUlyNO+/vSXvv71TTjzvv73vv70vXHUwMDBla2ZGLlnvv71277+9Ju+/vULvv73vv73vv73vv73vv73vv71T77+9Lu+/vVx1MDAxOXRcbu+/vUbvv71ccjnvv71cdTAwMTbUgO+/ve+/ve+/vdeUVe+/vWrvv71cdTAwMTIwPmFR77+9M++/vVx1MDAxNe+/vT9Y77+977+9Tu+/vVx1MDAwMi5j77+977+9Ljnvv717YT7vv73vv73Dp0kl77+9fu+/vXV+77+9XHUwMDE477+977+9Oe+/vcu577+9ZFx1MDAxMO+/ve+/vU1277+977+977+977+9cHfclO+/ve+/vVx1MDAwMFx1MDAwMFx1MDAwMyJd`

test();
// rtsp://127.0.0.1:9999/isapi/streaming/channels/302

let cport;
let sudp;

function test() {
  var h = JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
  var net = require('net');

  var server = net.createServer(function(client) {
    var seq = 0;
    client.on('data', function(data) {
      const msg = data.toString();
      console.log(msg);
      /*
      if (msg.indexOf('client_port=') !== -1) {
   
      }
      */
      
      const str = h[seq].replace(/\+\+/g, '\r\n');
      
      if (seq === 0){
        const a = [
          'RTSP/1.0 200 OK',
          'CSeq: ' + '2',
          'Public: OPTIONS, DESCRIBE, PLAY, PAUSE, SETUP, TEARDOWN, SET_PARAMETER, GET_PARAMETER',
        ]
        client.write(a.join('\r\n') + '\r\n\r\n');
      }

      if (seq === 1){
        const a = [
          'RTSP/1.0 200 OK',
          'CSeq: ' + '3',
          'Content-Type: application/sdp',
          'Content-Base: rtsp://127.0.0.1:9999/isapi/streaming/channels/302',
          'Content-Length' + str.split('Content-Length')[1],
        ]
        client.write(a.join('\r\n') + '\r\n\r\n');
      }

      if (seq === 2) {
        sudp = udp.createSocket('udp4');
        sudp.on('message', (msg, { port }) => {
          if (!cport) {
            cport = port;
          }
        });
        sudp.bind(47000, () => {
          const a = [
            'RTSP/1.0 200 OK',
            'CSeq: ' + '4',
            'Session: 1809048188;timeout=9999999',
            `Transport: RTP/AVP;unicast;client_port=35943-35944;server_port=${47000}-${47000 + 1};ssrc=258e3bf6;mode="play"`
          ]
          client.write(a.join('\r\n') + '\r\n\r\n');
        });
      }

      if (seq === 3) {
        const a = [
          'RTSP/1.0 200 OK',
          'CSeq: ' + '5',
          'Session: 1809048188',
          'RTP-Info: url=rtsp://127.0.0.1:9999/isapi/streaming/channels/302/trackID=video;seq=55535;rtptime=1689161868'
        ]
        client.write(a.join('\r\n') + '\r\n\r\n');
      }
      
      seq++;
    });
    
    client.on('close', function() {
      console.log('Connection closed');
    });
  });

  server.listen(9999, '127.0.0.1');

  
  const rtsp = new Rtsp({
    "chan": "cam_1",
    "name":"Cam1",
    "url": "rtsp://admin:Miheev998877@127.0.0.1:5554/ISAPI/Streaming/Channels/302",
    "type": "rtsp/h264",
    "protocol": "tcp",
    "transport": "p2p",
    "comment": ""
  });


  
  rtsp.on('play', (i) => {});
  rtsp.on('stream', (i) => {
    if (cport) {
      sudp.send(i.data, cport, '127.0.0.1');
    }
  });
  rtsp.on('close', () => console.log('close'));
  rtsp.on('debug', () => console.log('debug'));
  rtsp.on('error', () => console.log('error'));
  
}