#pragma once

#ifndef __has_builtin
#define __has_builtin(x) 0
#endif

#if !__has_builtin(__builtin_clzg)
#define __builtin_clzg(x, width) \
  ((x) == 0 ? (width) : \
   (sizeof(x) <= sizeof(unsigned int) ? (__builtin_clz((unsigned int)(x)) - (int)(sizeof(unsigned int) * 8 - (width))) : \
    (__builtin_clzll((unsigned long long)(x)) - (int)(sizeof(unsigned long long) * 8 - (width)))))
#endif

#if !__has_builtin(__builtin_ctzg)
#define __builtin_ctzg(x, width) \
  ((x) == 0 ? (width) : \
   (sizeof(x) <= sizeof(unsigned int) ? __builtin_ctz((unsigned int)(x)) : __builtin_ctzll((unsigned long long)(x))))
#endif
