# Benchmark

The included `bench.mjs` script evaluates loading performance for all
supported formats. It loads the file 11 times and reports the time for
the last 10 (ignoring the first cold-start / disk cache run).

## Running the Benchmark

```bash
node bench.mjs dpsv.trx
```

## Results

The graph below shows load time for the left inferior fronto-occipital
fasciculus (IFOF) from the HCP1065 Population-Averaged Tractography Atlas
(Yeh, 2022) — 21,209 streamlines and 4,915,166 vertices.

Formats were generated with
[tff_convert_tractogram.py](https://github.com/tee-ar-ex/trx-python).
Benchmark run on a MacBook with an M2 Pro CPU, loading from local SSD.

![M2 Performance](/_static/M2.png)

### Format Summary

| Format | Extension | Notes |
|--------|-----------|-------|
| tt | `.tt` | DSI Studio — very compact; 1/32 voxel precision (slightly lossy) |
| tt.gz | `.tt.gz` | Gzip-compressed DSI Studio |
| vtk | `.vtk` | VTK legacy (DiPy OFFSETS, `--offsets_dtype uint32`) |
| tck | `.tck` | MRtrix format |
| trk | `.trk` | TrackVis format |
| trk.gz | `.trk.gz` | Gzip-compressed TrackVis |
| trk.zst | `.trk.zst` | Zstandard-compressed TrackVis |
| trx | `.trx` | Uncompressed TRX |
| z.trx | `.trx` | Zip-compressed TRX |
| 16.trx | `.trx` | TRX with float16 positions |
| 16z.trx | `.trx` | Zip-compressed TRX with float16 positions |

> Note: Native zstd decompression is very fast, but the JavaScript
> decompressor (`fzstd`) is relatively slower than native implementations.
