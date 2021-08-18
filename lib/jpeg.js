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

function response_basic(error, response, body) {
  if (error === null && response.statusCode === 200) {
    console.log('ok')
  } else {
    console.log('fail')
  }
}

function http(url, callback) {
  const options = { uri: url, encoding: null }
  request(options, (error, response, body) => {
    if (error === null && response.statusCode === 200) {
      callback(null, body)
    } else {
      callback('fail', null)
    }
  });
}

function http_basic_auth(url, callback) {
  const parse = parseUrl(url)
  const options = {
    uri: parse.url,
    encoding: null,
    auth: {
      user: parse.login,
      pass: parse.pass,
    }
  };
  request(options, (error, response, body) => {
    if (error === null && response.statusCode === 200) {
      callback(null, body)
    } else {
      callback('fail', null)
    }
  });
}

function http_basic_auth_digest(url, callback) {
  const parse = parseUrl(url)
  const options = {
    uri: parse.url,
    encoding: null,
    auth: {
      user: parse.login,
      pass: parse.pass,
      sendImmediately: false,
    }
  };
  request(options, (error, response, body) => {
    if (error === null && response.statusCode === 200) {
      callback(null, body)
    } else {
      callback('fail', null)
    }
  });
}



function jpeg(url = 'http://127.0.0.1:80/', timeout = 10) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject('timeout'), timeout * 1000)
    http(url, (err, body) => {
      if (err === null) {
        clearTimeout(timer);
        resolve(body);
      } else {
        http_basic_auth(url, (err1, body1) => {
          if (err1 === null) {
            clearTimeout(timer);
            resolve(body1);
          } else {
            http_basic_auth_digest(url, (err2, body2) => {
              if (err2 === null) {
                clearTimeout(timer);
                resolve(body2);
              } else {
                clearTimeout(timer);
                reject('fail');
              }
            });
          }
        });
      }
    });
  });
}

module.exports = jpeg;
