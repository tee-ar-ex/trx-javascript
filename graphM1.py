#!/usr/bin/env python3
# -*- coding: utf-8 -*-


import pandas as pd
from matplotlib import pyplot as plt

# Set the figure size
plt.rcParams["figure.figsize"] = [7.00, 3.50]
plt.rcParams["figure.autolayout"] = True

# Create a dataframe
df = pd.DataFrame(
   dict(
      time=[2354, 3337, 3418, 11509, 15376, 494, 8161, 14928, 21013],
      bytes=[217428604, 137615686, 137369684, 59896111, 38597377, 137369222, 62858566, 68746592, 53953006],
      points=['vtk', 'tck', 'trk', 'trk.gz', 'trk.zst', 'trx', 'z.trx', '16.trx', '16z.trx']
   )
)

# Scatter plot
ax = df.plot.scatter(title='MacBook Air M1', x='time', y='bytes', alpha=0.5)
ax.set_ylim(ymin=0)
# Annotate each data point
for i, txt in enumerate(df.points):
   ax.annotate(txt, (df.time.iat[i], df.bytes.iat[i]))

#plt.show()
plt.savefig('M1.png', dpi=300)