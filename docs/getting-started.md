# Getting Started

## Installation

The library is a single ES module with no build step. Install the required
dependencies via npm:

```bash
npm install gl-matrix fflate fzstd
```

## Requirements

- **Node.js** >= 14.11.2 (for local usage)
- Modern web browser (for in-browser usage)

## Quick Start

### Command Line

```bash
git clone https://github.com/tee-ar-ex/trx-javascript
cd trx-javascript
npm install gl-matrix fflate fzstd
node bench.mjs dpsv.trx
```

### In Your Code

```javascript
import { readTRK, readTCK, readVTK, readTRX, readTT } from './streamlineIO.mjs';
import * as fs from 'fs';

// TRK, TCK, VTK, TT — synchronous, from ArrayBuffer
const trkData = readTRK(fs.readFileSync('tracts.trk').buffer);
console.log(`${trkData.offsetPt0.length - 1} streamlines`);

// TRX — async (supports URL or local file)
const trxData = await readTRX('tracts.trx');
console.log(trxData.header);
```

## Live Demo

[NiiVue provides a WebGL live demo](https://niivue.github.io/niivue/features/tracts.html)
that uses this library. You can drag and drop streamline files in any
supported format.
