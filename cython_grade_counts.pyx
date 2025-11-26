# cython: language_level=3
# cython: boundscheck=False
# cython: wraparound=False
# cython: cdivision=True

import numpy as np
cimport numpy as cnp
from cython.parallel import prange
cimport cython

ctypedef cnp.uint8_t UINT8
ctypedef cnp.uint16_t UINT16
ctypedef cnp.uint32_t UINT32

@cython.boundscheck(False)
@cython.wraparound(False)
cpdef cnp.ndarray[UINT16, ndim=3] count_grades(cnp.ndarray[UINT8, ndim=3] stacked):
    cdef Py_ssize_t n = stacked.shape[0]
    if n == 0:
        raise ValueError("stacked array is empty")
    cdef Py_ssize_t h = stacked.shape[1]
    cdef Py_ssize_t w = stacked.shape[2]

    cdef cnp.ndarray[UINT32, ndim=3] counts = np.zeros((8, h, w), dtype=np.uint32)
    cdef UINT8[:,:,:] data = stacked
    cdef UINT32[:,:,:] counter = counts

    cdef Py_ssize_t i, y, x
    cdef UINT8 val

    with nogil:
        for y in prange(h, schedule='static'):
            for x in range(w):
                for i in range(n):
                    val = data[i, y, x]
                    if val < 8:
                        counter[val, y, x] += 1

    return counts.astype(np.uint16, copy=False)
