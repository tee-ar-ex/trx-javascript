# trx-javascript

A minimal JavaScript reader for brain tractography streamline formats:
**TRX**, **TRK**, **TCK**, **VTK**, and **TT** (DSI Studio).

[Live Demo (NiiVue)](https://niivue.github.io/niivue/features/tracts.html)

## Quick Start

```bash
npm install gl-matrix fflate fzstd
node bench.mjs dpsv.trx
```

## Documentation

Full documentation is available at the
[project website](https://tee-ar-ex.github.io/trx-javascript).

### Building the documentation

To build the documentationl locally, install jsdoc:

   npm install -g jsdoc

And python dependencies:

   pip install sphinx myst-parser pydata-sphinx-theme sphinx-js

And then run `make html`




