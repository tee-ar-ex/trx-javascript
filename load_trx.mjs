//Install dependencies
// npm install fflate
//Test on tractogram
// node trx.mjs dpv.trx

import * as fflate from "fflate";
import * as fs from "fs";

async function readTRX(url, urlIsLocalFile = false) {
  //Javascript does not support float16, so we convert to float32
  //https://stackoverflow.com/questions/5678432/decompressing-half-precision-floats-in-javascript
  function decodeFloat16(binary) {
    "use strict";
    var exponent = (binary & 0x7c00) >> 10,
      fraction = binary & 0x03ff;
    return (
      (binary >> 15 ? -1 : 1) *
      (exponent
        ? exponent === 0x1f
          ? fraction
            ? NaN
            : Infinity
          : Math.pow(2, exponent - 15) * (1 + fraction / 0x400)
        : 6.103515625e-5 * (fraction / 0x400))
    );
  } // decodeFloat16()
  let noff = 0;
  let npt = 0;
  let pts = [];
  let offsetPt0 = [];
  let dpg = [];
  let dps = [];
  let dpv = [];
  let header = [];
  let isOverflowUint64 = false;
  let data = [];
  if (urlIsLocalFile) {
    data = fs.readFileSync(url);
  } else {
    let response = await fetch(url);
    if (!response.ok) throw Error(response.statusText);
    data = await response.arrayBuffer();
  }
  const decompressed = fflate.unzipSync(data, {
    filter(file) {
      return file.originalSize > 0;
    }
  });
  var keys = Object.keys(decompressed);
  for (var i = 0, len = keys.length; i < len; i++) {
    //console.log('>>>', decompressed[keys[i]]);
    let parts = keys[i].split("/");
    let fname = parts.slice(-1)[0]; // my.trx/dpv/fx.float32 -> fx.float32
    if (fname.startsWith(".")) continue;
    let pname = parts.slice(-2)[0]; // my.trx/dpv/fx.float32 -> dpv
    let tag = fname.split(".")[0]; // "positions.3.float16 -> "positions"
    //todo: should tags be censored for invalide characters: https://stackoverflow.com/questions/8676011/which-characters-are-valid-invalid-in-a-json-key-name
    let data = decompressed[keys[i]];
    if (fname.includes("header.json")) {
      let jsonString = new TextDecoder().decode(data);
      header = JSON.parse(jsonString);
      continue;
    }
    //next read arrays for all possible datatypes: int8/16/32/64 uint8/16/32/64 float16/32/64
    let nval = 0;
    let vals = [];
    if (fname.endsWith(".uint64") || fname.endsWith(".int64")) {
      //javascript does not have 64-bit integers! read lower 32-bits
      //note for signed int64 we only read unsigned bytes
      //for both signed and unsigned, generate an error if any value is out of bounds
      //one alternative might be to convert to 64-bit double that has a flintmax of 2^53.
      nval = data.length / 8; //8 bytes per 64bit input
      vals = new Uint32Array(nval);
      var u32 = new Uint32Array(data.buffer);
      let j = 0;
      for (let i = 0; i < nval; i++) {
        vals[i] = u32[j];
        if (u32[j + 1] !== 0) isOverflowUint64 = true;
        j += 2;
      }
    } else if (fname.endsWith(".uint32")) {
      vals = new Uint32Array(data.buffer);
    } else if (fname.endsWith(".uint16")) {
      vals = new Uint16Array(data.buffer);
    } else if (fname.endsWith(".uint8")) {
      vals = new Uint8Array(data.buffer);
    } else if (fname.endsWith(".int32")) {
      vals = new Int32Array(data.buffer);
    } else if (fname.endsWith(".int16")) {
      vals = new Int16Array(data.buffer);
    } else if (fname.endsWith(".int8")) {
      vals = new Int8Array(data.buffer);
    } else if (fname.endsWith(".float64")) {
      vals = new Float64Array(data.buffer);
    } else if (fname.endsWith(".float32")) {
      vals = new Float32Array(data.buffer);
    } else if (fname.endsWith(".float16")) {
      //javascript does not have 16-bit floats! Convert to 32-bits
      nval = data.length / 2; //2 bytes per 16bit input
      vals = new Float32Array(nval);
      var u16 = new Uint16Array(data.buffer);
      for (let i = 0; i < nval; i++) vals[i] = decodeFloat16(u16[i]);
    } else continue; //not a data array
    nval = vals.length;
    //next: read data_per_group
    if (pname.includes("dpg")) {
      dpg.push({
        id: tag,
        vals: vals.slice(),
      });
      continue;
    }
    //next: read data_per_vertex
    if (pname.includes("dpv")) {
      dpv.push({
        id: tag,
        vals: vals.slice(),
      });
      continue;
    }
    //next: read data_per_streamline
    if (pname.includes("dps")) {
      dps.push({
        id: tag,
        vals: vals.slice(),
      });
      continue;
    }
    //Next: read offsets: Always uint64
    if (fname.startsWith("offsets.")) {
      //javascript does not have 64-bit integers! read lower 32-bits
      noff = nval; //8 bytes per 64bit input
      //we need to solve the fence post problem, so we can not use slice
      offsetPt0 = new Uint32Array(nval + 1);
      for (let i = 0; i < nval; i++) offsetPt0[i] = vals[i];
    }
    if (fname.startsWith("positions.3.")) {
      npt = nval; //4 bytes per 32bit input
      pts = vals.slice();
    }
  }
  if (noff === 0 || npt === 0) alert("Failure reading TRX format");
  if (isOverflowUint64)
    alert("Too many vertices: JavaScript does not support 64 bit integers");
  offsetPt0[noff] = npt / 3; //solve fence post problem, offset for final streamline
  return {
    pts,
    offsetPt0,
    dpg,
    dps,
    dpv,
    header,
  };
}; // readTRX()

async function main() {
    let argv = process.argv.slice(2);
    let argc = argv.length;
    if (argc < 1) {
        console.log("arguments required: 'node trx.js filename.trx'")
        return
    }
    //check input filename
    let fnm = argv[0];
    if (!fs.existsSync(fnm)) {
        console.log("Unable to find NIfTI: " + fnm);
        return
    }
    let obj = await readTRX(fnm, true);
    console.log("Vertices:" + obj.pts.length / 3);
    console.log(" First vertex (x,y,z):" + obj.pts[0] + ',' + obj.pts[1] + ',' + obj.pts[2]);
    console.log("Streamlines: " + (obj.offsetPt0.length - 1)); //-1 due to fence post
    console.log(" Vertices in first streamline: " + (obj.offsetPt0[1] - obj.offsetPt0[0]));
    console.log("dpg (data_per_group) items: " + obj.dpg.length);
    for (let i = 0; i < obj.dpg.length; i++)
        console.log("  '" + obj.dpg[i].id + "' items: " + obj.dpg[i].vals.length);
    console.log("dps (data_per_streamline) items: " + obj.dps.length);
    for (let i = 0; i < obj.dps.length; i++)
        console.log("  '" + obj.dps[i].id + "' items: " + obj.dps[i].vals.length);
    console.log("dpv (data_per_vertex) items: " + obj.dpv.length);
    for (let i = 0; i < obj.dpv.length; i++)
        console.log("  '" + obj.dpv[i].id + "' items: " + obj.dpv[i].vals.length);
    console.log("Header (header.json):");
    console.log(obj.header);
}
main().then(() => console.log('Done'))