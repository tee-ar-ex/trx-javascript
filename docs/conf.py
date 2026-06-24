import os
import sys

sys.path.insert(0, os.path.abspath('.'))

project = 'trx-javascript'
copyright = '2026, trx-javascript contributors'
author = 'trx-javascript contributors'
release = '1.0'

extensions = [
    'myst_parser',
    'sphinx_js',
    'sphinx.ext.autosectionlabel',
]

js_source_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
jsdoc_config_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'jsdoc.json'))

templates_path = ['_templates']
exclude_patterns = ['_build', 'venv', 'Thumbs.db', '.DS_Store', 'node_modules']

html_theme = 'pydata_sphinx_theme'
html_static_path = ['_static']

myst_enable_extensions = [
    "colon_fence",
    "deflist",
    "tasklist",
]

autosectionlabel_prefix_document = True
