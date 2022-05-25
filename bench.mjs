//Install dependencies
// npm install gl-matrix fflate fzstd
//Test on tractogram
// node bench.mjs dpsv.trx

import * as streamline from "./streamlineIO.mjs";
import * as fs from "fs";

async function main() {
    let argv = process.argv.slice(2);
    let argc = argv.length;
    if (argc < 1) {
        console.log("arguments required: 'node bench.mjs dpsv.trx'")
        return
    }
    //check input filename
    let fnm = argv[0];
    if (!fs.existsSync(fnm)) {
        console.log("Unable to find NIfTI: " + fnm);
        return
    }
    let re = /(?:\.([^.]+))?$/;
    let ext = re.exec(fnm)[1];
    ext = ext.toUpperCase();
    let obj = [];
    let d = Date.now();
    let nrepeats = 11; //11 iterations, ignore first
    for (let i = 0; i < nrepeats; i++) {
        if (i == 1) d = Date.now(); //ignore first run for interpretting/disk
        if (ext === "FIB" || ext === "VTK" || ext === "TCK" || ext === "TRK" || ext === "GZ" || ext === "ZSTD" || ext === "ZST") {
            const buf = fs.readFileSync(fnm);
            if (ext === "TCK")
                obj = streamline.readTCK(new Uint8Array(buf).buffer);
            else if (ext === "FIB" || ext === "VTK")
                obj = streamline.readVTK(new Uint8Array(buf).buffer);
            else
                obj = streamline.readTRK(new Uint8Array(buf).buffer);
        } else {
            obj = await streamline.readTRX(fnm, true);
        }
    }
    let ms = Date.now() - d;
    //find file size:
    let dat = fs.readFileSync(fnm);
    console.log(`${fnm}\tSize\t${dat.length}\tTime\t${ms}`);
    console.log("Vertices:" + obj.pts.length / 3);
    console.log(" First vertex (x,y,z):" + obj.pts[0] + ',' + obj.pts[1] + ',' + obj.pts[2]);
    console.log("Streamlines: " + (obj.offsetPt0.length - 1)); //-1 due to fence post
    console.log(" Vertices in first streamline: " + (obj.offsetPt0[1] - obj.offsetPt0[0]));
    if (obj.hasOwnProperty("dpg")) {
        console.log("dpg (data_per_group) items: " + obj.dpg.length);
        for (let i = 0; i < obj.dpg.length; i++)
            console.log("  '" + obj.dpg[i].id + "' items: " + obj.dpg[i].vals.length);
    }
    if (obj.hasOwnProperty("dps")) {
        console.log("dps (data_per_streamline) items: " + obj.dps.length);
        for (let i = 0; i < obj.dps.length; i++)
            console.log("  '" + obj.dps[i].id + "' items: " + obj.dps[i].vals.length);
    }
    if (obj.hasOwnProperty("dpv")) {
        console.log("dpv (data_per_vertex) items: " + obj.dpv.length);
        for (let i = 0; i < obj.dpv.length; i++)
            console.log("  '" + obj.dpv[i].id + "' items: " + obj.dpv[i].vals.length);
    }
    if (obj.hasOwnProperty("header")) {
        console.log("Header (header.json):");
        console.log(obj.header);
    }
}
main().then(() => console.log('Done'))