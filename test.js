const { fork } = require('child_process');
const os = require('os');


const options = {
  port: 8088,
  syspath: '/opt/ih-v5',
  hwid: '23a2cab6b81b02d18668fa676e8f3c4eb68577cb33f02be50774b4bfa742ae09-1110',
  logfile: '/opt/ih-v5/log/ih_cctv.log',
  temppath: os.tmpdir(),
}

const params = { wsport: 8099 };
const channels = [
  {
    id: "cam_1",
    chan: "cam_1",
    name: "Cam1",
    url: "rtsp://user:pwd@192.168.0.xxx:port/videoMain",
    type: "rtsp/h264",
    protocol: "udp",
    transport: "p2p",
    comment: "",
    snap_url: "",
    snap_timeout: 30
  }
]


const forked = fork('index.js', [JSON.stringify(options), 'debug']);

forked.on('message', (msg) => {
  if (msg.type === 'get' && msg.name === 'params') {
    forked.send({ ...msg, response: 1, data: params })
  } else if (msg.type === 'get' && msg.name === 'channels') {
    forked.send({ ...msg, response: 1, data: channels })
  } else {
    console.log(msg);
  }
});


setTimeout(() => forked.send({ type: 'command', command: 'snap', camid: 'cam_1' }), 1000); 

