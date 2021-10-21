const plugin = require('ih-plugin-api')();

const Peer = require('simple-peer');
const wrtc = require('wrtc');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const Rtsp = require('./lib/rtsp');
const Snapshot = require('./lib/snapshot');
const HttpStream = require('./lib/http-stream');
const jpeg = require('./lib/jpeg');
const tools = require('./lib/tools');


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

let opt = {};
let settings = {};
let channels = [];

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
  if (typeof msg === 'object' && msg.type === 'command' && msg.command !== undefined) {
    if (msg.command === 'snap' && msg.camid) {
      const cam = channels.find(i => i.id === msg.camid)

      if (cam && cam.snap_url) {
        jpeg(cam.snap_url, cam.snap_timeout)
          .then((data) => {
            const pathDir = path.join(opt.temppath, 'snapshot');
            const filename = `snap_${Date.now()}.jpg`;
            const pathFile = path.join(pathDir, filename);
            
            if (!fs.existsSync(pathDir)){
                fs.mkdirSync(pathDir);
            }

            try {
              fs.writeFileSync(pathFile, data);
              process.send({ ...msg, response: 1, payload: { filename: pathFile } });
            } catch (e) {
              process.send({ ...msg, response: 0, message: e.message });
            }
          })
          .catch((msg) => {
            process.send({ ...msg, response: 0, message: msg });
          });
      }
    }
  }
});

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
  opt = plugin.opt;
  settings = await plugin.params.get();
  channels = await plugin.channels.get();

  plugin.log(`transport WebSocket: ${settings.wsport || 8099}`)

  const wss = new WebSocket.Server({ port: settings.wsport || 8099 });
  wss.on('connection', ws_connection);

  setInterval(systemCheck, SYSTEM_CHECK_INTERVAL);
}

main();