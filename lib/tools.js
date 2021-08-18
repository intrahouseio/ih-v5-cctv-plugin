const BEGIN = 'ffd8ffe000104a46494600010200000100010000';
const DQT1 = 'ffdb0043000d090a0b0a080d0b0a0b0e0e0d0f13201513121213271c1e17202e2931302e292d2c333a4a3e333646372c2d405741464c4e525352323e5a615a50604a51524f';
const DQT2 = 'ffdb0043010e0e0e131113261515264f352d354f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f';
const SOF0 = 'ffc000110802d0050003012200021101031101'
const DRI = 'ffdd00040050';
const DHT = 'ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffc4001f0100030101010101010101010000000000000102030405060708090a0bffc400b51100020102040403040705040400010277000102031104052131061241510761711322328108144291a1b1c109233352f0156272d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a82838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9fa';
const SOS = 'ffda000c03010002110311003f00';


const ZigZag = [
     0, 1, 5, 6,14,15,27,28,
     2, 4, 7,13,16,26,29,42,
     3, 8,12,17,25,30,41,43,
     9,11,18,24,31,40,44,53,
    10,19,23,32,39,45,52,54,
    20,22,33,38,46,51,55,60,
    21,34,37,47,50,56,59,61,
    35,36,48,49,57,58,62,63
  ];

const YQT = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99
];

const UVQT = [
	17, 18, 24, 47, 99, 99, 99, 99,
	18, 21, 26, 66, 99, 99, 99, 99,
	24, 26, 56, 99, 99, 99, 99, 99,
	47, 66, 99, 99, 99, 99, 99, 99,
	99, 99, 99, 99, 99, 99, 99, 99,
	99, 99, 99, 99, 99, 99, 99, 99,
	99, 99, 99, 99, 99, 99, 99, 99,
	99, 99, 99, 99, 99, 99, 99, 99
];

function getQuality(quality){
  if (quality <= 0) {
			quality = 1;
		}
		if (quality > 100) {
			quality = 100;
		}

		let sf = 0;

		if (quality < 50) {
			sf = Math.floor(5000 / quality);
		} else {
			sf = Math.floor(200 - quality*2);
		}

	  return sf;
}

function genDQT1(q) {
  const temp = new Buffer.from(UVQT.map(i => Math.floor((i * q + 50) / 100))).toString('hex');
  return 'ffdb004300' + temp;
}

function genDQT1(q) {
  const temp = [];
  const temp1 = YQT.map(i => {
    const t = Math.floor((i * q + 50) / 100);
    if (t < 1) {
      return 1;
    }
    if (t > 255) {
      return 255;
    }
    return t;
  });

  temp1.forEach((item, key) => {
    temp[ZigZag[key]] = item;
  });

  const temp2 = new Buffer.from(temp).toString('hex');
  return 'ffdb004300' + temp2;
}


function genDQT2(q) {
  const temp = [];
  const temp1 = UVQT.map(i => {
    const u = Math.floor((i * q + 50) / 100);
    if (u < 1) {
      return 1;
    }
    if (u > 255) {
      return 255;
    }
    return u;
  })

  temp1.forEach((item, key) => {
    temp[ZigZag[key]] = item;
  });

  const temp2 = new Buffer.from(temp).toString('hex');
  return 'ffdb004301' + temp2;
}


function genJpegHeader(reset, quant, data) {

  const q = getQuality(data[17]);


  let MDQT1 = DQT1;
  let MDQT2 = DQT2;
  let MSOF0 = '';
  let MDRI = '';

  if (quant) {
    if (reset) {
      const l = data.readUInt16BE(26);
      const t1 = data.slice(28, 28 + (l / 2)).toString('hex');
      const t2 = data.slice(28 + (l/ 2), 28 + (l/ 2) + (l / 2)).toString('hex');
      MDQT1 = `ffdb${('0000' + (t1.length / 2 + 3).toString(16)).slice(-4)}00` + t1;
      MDQT2 = `ffdb${('0000' + (t1.length / 2 + 3).toString(16)).slice(-4)}01` + t1;
    } else {
      const l = data.readUInt16BE(22);
      const t1 = data.slice(24, 24 + (l / 2)).toString('hex');
      const t2 = data.slice(24 + (l/ 2), 24 + (l/ 2) + (l / 2)).toString('hex');
      MDQT1 = `ffdb${('0000' + (t1.length / 2 + 3).toString(16)).slice(-4)}00` + t1;
      MDQT2 = `ffdb${('0000' + (t1.length / 2 + 3).toString(16)).slice(-4)}01` + t1;
    }
  } else {
    MDQT1 = genDQT1(q);
    MDQT2 = genDQT2(q);
  }

  if (reset) {
    MDRI = 'ffdd0004' + data.slice(20, 22).toString('hex');
  }

  MSOF0 = 'ffc0001108' + ('0000' + (data[19] * 8).toString(16)).slice(-4) + ('0000' + (data[18] * 8).toString(16)).slice(-4) + '03012200021101031101';

  const headers = [
    BEGIN,
    MDQT1,
    MDQT2,
    MSOF0,
    MDRI,
    DHT,
    SOS,
  ];

  return Buffer.from(headers.join(''), 'hex');
}

function sliceJpegData(reset, quant, data) {
  let i = 20;

  if (reset) {
    i = i + 4;
  }

  if (quant) {
    i = i + 132;
  }
  return data.slice(i);
}

module.exports = {
  genJpegHeader,
  sliceJpegData,
};
