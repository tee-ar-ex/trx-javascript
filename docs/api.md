# API Reference

All reader functions return an object with the following structure:

| Field | Type | Description |
|-------|------|-------------|
| `pts` | `Float32Array` | Interleaved XYZ vertex positions for all streamlines |
| `offsetPt0` | `Uint32Array` | Start index of each streamline in `pts` (NB_STREAMLINES + 1 entries) |
| `dps` | `Array<{id, vals}>` | Data-per-streamline (TRX, TRK) |
| `dpv` | `Array<{id, vals}>` | Data-per-vertex (TRX, TRK) |
| `dpg` | `Array<{id, vals}>` | Data-per-group (TRX only) |
| `header` | `Object` | Parsed `header.json` (TRX only) |

## Reader Functions

### readTRK

```{js:autofunction} readTRK
```

### readTCK

```{js:autofunction} readTCK
```

### readVTK

```{js:autofunction} readVTK
```

### readTRX

```{js:autofunction} readTRX
```

### readTT

```{js:autofunction} readTT
```
