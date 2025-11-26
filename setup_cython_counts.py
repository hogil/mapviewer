import sys
import numpy as np
from setuptools import setup, Extension
from Cython.Build import cythonize

compile_args = []
link_args = []
if sys.platform.startswith("win"):
    compile_args.append("/openmp")
    link_args.append("/openmp")
else:
    compile_args.append("-fopenmp")
    link_args.append("-fopenmp")

ext = Extension(
    "cython_grade_counts",
    sources=["cython_grade_counts.pyx"],
    extra_compile_args=compile_args,
    extra_link_args=link_args,
)

setup(
    name="cython_grade_counts",
    ext_modules=cythonize(ext, language_level=3),
    include_dirs=[np.get_include()],
)
