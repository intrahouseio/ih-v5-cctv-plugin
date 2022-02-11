const fs = require('fs');
const Rtsp = require('./lib/rtsp');



const rtsp = new Rtsp({
  "chan": "cam_1",
  "name":"Cam1",
  "url": c,
  "type": "rtsp/h264",
  "protocol": "tcp",
  "transport": "p2p",
  "comment": "",
  "check_pps": false,
});
  
rtsp.on('play', (i) => console.log(i));
rtsp.on('stream', (i) => {});
rtsp.on('close', () => console.log('close'));
rtsp.on('debug', (i) => {});
rtsp.on('error', (e) => console.log('error', e));
  
