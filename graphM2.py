import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns

# Create a dataframe
data = {
    'format': ['vtk', 'tck', 'trk', 'trk.gz', 'trk.zst', 'trx', 'z.trx', '16.trx', '16z.trx'],
    'time': [459, 866, 924, 3881, 4012, 159, 2763, 373, 2708],
    'bytes': [113218694, 59236654, 59067828, 28746432, 28291562, 59152204, 28502799, 29661208, 24245538]
}

df = pd.DataFrame(data)

# Define a color palette with as many colors as there are formats
colors = sns.color_palette('husl', n_colors=len(df['format']))

# Set a larger figure size
plt.figure(figsize=(10, 5))

# Create a scatter plot with different colors for each format and double the diameter of each point
ax = sns.scatterplot(x='time', y='bytes', hue='format', palette=colors, s=200, data=df)

# Set the legend outside the plot for better visibility
ax.legend(title='Format', bbox_to_anchor=(1.05, 1), loc='upper left')

plt.title('Relative Time vs Size for Each Format')
plt.xlabel('Relative Time')
plt.ylabel('Size (Bytes)')

plt.tight_layout()  # Adjust layout to prevent clipping
#plt.show()
plt.savefig('M2.png', dpi=300)