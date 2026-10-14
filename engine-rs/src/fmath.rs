//! Math.log, Math.exp, Math.pow, Math.sin and Math.cos exactly as V8 computes them: fdlibm's
//! __ieee754_log / exp / pow and the sin / cos kernels (V8's src/base/ieee754.cc). The engine uses these
//! instead of the platform's libm, so a native build, the WebAssembly build and the TypeScript reference
//! agree to the last bit.

fn hi(x: f64) -> i32 {
    (x.to_bits() >> 32) as i32
}
fn lo(x: f64) -> u32 {
    x.to_bits() as u32
}
fn with_hi(x: f64, h: i32) -> f64 {
    f64::from_bits(((h as u32 as u64) << 32) | (x.to_bits() & 0xffff_ffff))
}
fn from_words(h: i32, l: u32) -> f64 {
    f64::from_bits(((h as u32 as u64) << 32) | l as u64)
}

pub fn log(x: f64) -> f64 {
    const LN2_HI: f64 = 6.93147180369123816490e-01;
    const LN2_LO: f64 = 1.90821492927058770002e-10;
    const TWO54: f64 = 1.80143985094819840000e+16;
    const LG1: f64 = 6.666666666666735130e-01;
    const LG2: f64 = 3.999999999940941908e-01;
    const LG3: f64 = 2.857142874366239149e-01;
    const LG4: f64 = 2.222219843214978396e-01;
    const LG5: f64 = 1.818357216161805012e-01;
    const LG6: f64 = 1.531383769920937332e-01;
    const LG7: f64 = 1.479819860511658591e-01;
    let mut x = x;
    let mut hx = hi(x);
    let lx = lo(x);
    let mut k: i32 = 0;
    if hx < 0x00100000 {
        // x < 2**-1022
        if ((hx & 0x7fffffff) as u32 | lx) == 0 {
            return f64::NEG_INFINITY; // log(+-0) = -inf
        }
        if hx < 0 {
            return f64::NAN; // log(-#) = NaN
        }
        k -= 54;
        x *= TWO54; // subnormal number, scale up x
        hx = hi(x);
    }
    if hx >= 0x7ff00000 {
        return x + x;
    }
    k += (hx >> 20) - 1023;
    hx &= 0x000fffff;
    let i = (hx + 0x95f64) & 0x100000;
    x = with_hi(x, hx | (i ^ 0x3ff00000)); // normalize x or x/2
    k += i >> 20;
    let f = x - 1.0;
    if (0x000fffff & (2 + hx)) < 3 {
        // -2**-20 <= f < 2**-20
        if f == 0.0 {
            if k == 0 {
                return 0.0;
            }
            let dk = k as f64;
            return dk * LN2_HI + dk * LN2_LO;
        }
        let r = f * f * (0.5 - 0.33333333333333333 * f);
        if k == 0 {
            return f - r;
        }
        let dk = k as f64;
        return dk * LN2_HI - ((r - dk * LN2_LO) - f);
    }
    let s = f / (2.0 + f);
    let dk = k as f64;
    let z = s * s;
    let mut i = hx - 0x6147a;
    let w = z * z;
    let j = 0x6b851 - hx;
    let t1 = w * (LG2 + w * (LG4 + w * LG6));
    let t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
    i |= j;
    let r = t2 + t1;
    if i > 0 {
        let hfsq = 0.5 * f * f;
        if k == 0 {
            f - (hfsq - s * (hfsq + r))
        } else {
            dk * LN2_HI - ((hfsq - (s * (hfsq + r) + dk * LN2_LO)) - f)
        }
    } else if k == 0 {
        f - s * (f - r)
    } else {
        dk * LN2_HI - ((s * (f - r) - dk * LN2_LO) - f)
    }
}

pub fn exp(x: f64) -> f64 {
    const HALF: [f64; 2] = [0.5, -0.5];
    const O_THRESHOLD: f64 = 7.09782712893383973096e+02;
    const U_THRESHOLD: f64 = -7.45133219101941108420e+02;
    const LN2HI: [f64; 2] = [6.93147180369123816490e-01, -6.93147180369123816490e-01];
    const LN2LO: [f64; 2] = [1.90821492927058770002e-10, -1.90821492927058770002e-10];
    const INVLN2: f64 = 1.44269504088896338700e+00;
    const P1: f64 = 1.66666666666666019037e-01;
    const P2: f64 = -2.77777777770155933842e-03;
    const P3: f64 = 6.61375632143793436117e-05;
    const P4: f64 = -1.65339022054652515390e-06;
    const P5: f64 = 4.13813679705723846039e-08;
    const E: f64 = 2.718281828459045;
    const HUGE: f64 = 1.0e+300;
    const TWOM1000: f64 = 9.33263618503218878990e-302;
    const TWO1023: f64 = 8.988465674311579539e307;
    let mut x = x;
    let mut hx = hi(x) as u32;
    let xsb = ((hx >> 31) & 1) as usize;
    hx &= 0x7fffffff;
    let (hi_part, lo_part, k): (f64, f64, i32);
    // filter out non-finite argument
    if hx >= 0x40862E42 {
        // |x| >= 709.78...
        if hx >= 0x7ff00000 {
            if ((hx & 0xfffff) | lo(x)) != 0 {
                return x + x; // NaN
            }
            return if xsb == 0 { x } else { 0.0 }; // exp(+-inf) = {inf, 0}
        }
        if x > O_THRESHOLD {
            return f64::INFINITY; // overflow
        }
        if x < U_THRESHOLD {
            return 0.0; // underflow
        }
    }
    // argument reduction
    if hx > 0x3fd62e42 {
        // |x| > 0.5 ln2
        if hx < 0x3FF0A2B2 {
            // |x| < 1.5 ln2
            if x == 1.0 {
                return E;
            }
            hi_part = x - LN2HI[xsb];
            lo_part = LN2LO[xsb];
            k = 1 - xsb as i32 - xsb as i32;
        } else {
            k = (INVLN2 * x + HALF[xsb]) as i32;
            let t = k as f64;
            hi_part = x - t * LN2HI[0]; // t*ln2hi is exact here
            lo_part = t * LN2LO[0];
        }
        x = hi_part - lo_part;
    } else if hx < 0x3e300000 {
        // |x| < 2**-28
        if HUGE + x > 1.0 {
            return 1.0 + x; // trigger inexact
        }
        k = 0;
        hi_part = 0.0;
        lo_part = 0.0;
    } else {
        k = 0;
        hi_part = 0.0;
        lo_part = 0.0;
    }
    let _ = (hi_part, lo_part);
    // x is now in primary range
    let t = x * x;
    let twopk = if k >= -1021 { from_words(0x3ff00000 + (k << 20), 0) } else { from_words(0x3ff00000 + ((k + 1000) << 20), 0) };
    let c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    if k == 0 {
        return 1.0 - ((x * c) / (c - 2.0) - x);
    }
    let y = 1.0 - ((lo_part - (x * c) / (2.0 - c)) - hi_part);
    if k >= -1021 {
        if k == 1024 {
            return y * 2.0 * TWO1023;
        }
        y * twopk
    } else {
        y * twopk * TWOM1000
    }
}


fn set_lo(x: f64, l: u32) -> f64 {
    f64::from_bits((x.to_bits() & 0xffff_ffff_0000_0000) | l as u64)
}

/// fdlibm's __ieee754_pow (kept for reference: V8's Math.pow now calls the platform's pow)
#[allow(dead_code)]
pub fn fdlibm_pow(x: f64, y: f64) -> f64 {
    const BP: [f64; 2] = [1.0, 1.5];
    const DP_H: [f64; 2] = [0.0, 5.84962487220764160156e-01];
    const DP_L: [f64; 2] = [0.0, 1.35003920212974897128e-08];
    const TWO53: f64 = 9007199254740992.0;
    const HUGE: f64 = 1.0e300;
    const TINY: f64 = 1.0e-300;
    const L1: f64 = 5.99999999999994648725e-01;
    const L2: f64 = 4.28571428578550184252e-01;
    const L3: f64 = 3.33333329818377432918e-01;
    const L4: f64 = 2.72728123808534006489e-01;
    const L5: f64 = 2.30660745775561754067e-01;
    const L6: f64 = 2.06975017800338417784e-01;
    const P1: f64 = 1.66666666666666019037e-01;
    const P2: f64 = -2.77777777770155933842e-03;
    const P3: f64 = 6.61375632143793436117e-05;
    const P4: f64 = -1.65339022054652515390e-06;
    const P5: f64 = 4.13813679705723846039e-08;
    const LG2: f64 = 6.93147180559945286227e-01;
    const LG2_H: f64 = 6.93147182464599609375e-01;
    const LG2_L: f64 = -1.90465429995776804525e-09;
    const OVT: f64 = 8.0085662595372944372e-17;
    const CP: f64 = 9.61796693925975554329e-01;
    const CP_H: f64 = 9.61796700954437255859e-01;
    const CP_L: f64 = -7.02846165095275826516e-09;
    const IVLN2: f64 = 1.44269504088896338700e+00;
    const IVLN2_H: f64 = 1.44269502162933349609e+00;
    const IVLN2_L: f64 = 1.92596299112661746887e-08;

    let hx = hi(x);
    let lx = lo(x);
    let hy = hi(y);
    let ly = lo(y);
    let mut ix = hx & 0x7fffffff;
    let iy = hy & 0x7fffffff;

    // y == 0: x**0 = 1
    if (iy as u32 | ly) == 0 {
        return 1.0;
    }
    // NaN: x + y
    if ix > 0x7ff00000 || (ix == 0x7ff00000 && lx != 0) || iy > 0x7ff00000 || (iy == 0x7ff00000 && ly != 0) {
        return x + y;
    }
    // yisint: 0 not an integer, 1 odd, 2 even (when x < 0)
    let mut yisint = 0;
    if hx < 0 {
        if iy >= 0x43400000 {
            yisint = 2;
        } else if iy >= 0x3ff00000 {
            let k = (iy >> 20) - 0x3ff;
            if k > 20 {
                let j = ly >> (52 - k);
                if (j << (52 - k)) == ly {
                    yisint = 2 - (j & 1) as i32;
                }
            } else if ly == 0 {
                let j = iy >> (20 - k);
                if (j << (20 - k)) == iy {
                    yisint = 2 - (j & 1);
                }
            }
        }
    }
    // special values of y
    if ly == 0 {
        if iy == 0x7ff00000 {
            // y is ±inf
            if ((ix - 0x3ff00000) as u32 | lx) == 0 {
                return y - y; // ±1 ** ±inf is NaN
            } else if ix >= 0x3ff00000 {
                return if hy >= 0 { y } else { 0.0 };
            } else {
                return if hy < 0 { -y } else { 0.0 };
            }
        }
        if iy == 0x3ff00000 {
            return if hy < 0 { 1.0 / x } else { x };
        }
        if hy == 0x40000000 {
            return x * x;
        }
        if hy == 0x3fe00000 && hx >= 0 {
            return x.sqrt();
        }
    }
    let mut ax = x.abs();
    // special values of x
    if lx == 0 && (ix == 0x7ff00000 || ix == 0 || ix == 0x3ff00000) {
        let mut z = ax;
        if hy < 0 {
            z = 1.0 / z;
        }
        if hx < 0 {
            if ((ix - 0x3ff00000) | yisint) == 0 {
                z = (z - z) / (z - z); // (-1)**non-int is NaN
            } else if yisint == 1 {
                z = -z;
            }
        }
        return z;
    }
    let mut n: i32 = (((hx as u32) >> 31) as i32) ^ 1; // 1 for x >= 0, 0 for x < 0 (as (hx>>31)+1)
    // (x<0)**(non-int) is NaN
    if (n | yisint) == 0 {
        return (x - x) / (x - x);
    }
    let mut s = 1.0;
    if (n | (yisint - 1)) == 0 {
        s = -1.0; // (-ve)**(odd int)
    }
    let (t1, t2);
    if iy > 0x41e00000 {
        // |y| > 2**31
        if iy > 0x43f00000 {
            if ix <= 0x3fefffff {
                return if hy < 0 { HUGE * HUGE } else { TINY * TINY };
            }
            if ix >= 0x3ff00000 {
                return if hy > 0 { HUGE * HUGE } else { TINY * TINY };
            }
        }
        if ix < 0x3fefffff {
            return if hy < 0 { s * HUGE * HUGE } else { s * TINY * TINY };
        }
        if ix > 0x3ff00000 {
            return if hy > 0 { s * HUGE * HUGE } else { s * TINY * TINY };
        }
        let t = ax - 1.0;
        let w = (t * t) * (0.5 - t * (0.3333333333333333333333 - t * 0.25));
        let u = IVLN2_H * t;
        let v = t * IVLN2_L - w * IVLN2;
        let a = set_lo(u + v, 0);
        t1 = a;
        t2 = v - (a - u);
    } else {
        n = 0;
        // subnormal x
        if ix < 0x00100000 {
            ax *= TWO53;
            n -= 53;
            ix = hi(ax);
        }
        n += (ix >> 20) - 0x3ff;
        let j = ix & 0x000fffff;
        ix = j | 0x3ff00000;
        let k: usize;
        if j <= 0x3988E {
            k = 0;
        } else if j < 0xBB67A {
            k = 1;
        } else {
            k = 0;
            n += 1;
            ix -= 0x00100000;
        }
        ax = with_hi(ax, ix);
        // ss = s_h + s_l = (x-1)/(x+1) or (x-1.5)/(x+1.5)
        let u = ax - BP[k];
        let v = 1.0 / (ax + BP[k]);
        let ss = u * v;
        let s_h = set_lo(ss, 0);
        let t_h = from_words(((ix >> 1) | 0x20000000) + 0x00080000 + ((k as i32) << 18), 0);
        let t_l = ax - (t_h - BP[k]);
        let s_l = v * ((u - s_h * t_h) - s_h * t_l);
        // log(ax)
        let mut s2 = ss * ss;
        let mut r = s2 * s2 * (L1 + s2 * (L2 + s2 * (L3 + s2 * (L4 + s2 * (L5 + s2 * L6)))));
        r += s_l * (s_h + ss);
        s2 = s_h * s_h;
        let t_h2 = set_lo(3.0 + s2 + r, 0);
        let t_l2 = r - ((t_h2 - 3.0) - s2);
        let u2 = s_h * t_h2;
        let v2 = s_l * t_h2 + t_l2 * ss;
        let p_h = set_lo(u2 + v2, 0);
        let p_l = v2 - (p_h - u2);
        let z_h = CP_H * p_h;
        let z_l = CP_L * p_h + p_l * CP + DP_L[k];
        let t = n as f64;
        let a = set_lo(((z_h + z_l) + DP_H[k]) + t, 0);
        t1 = a;
        t2 = z_l - (((a - t) - DP_H[k]) - z_h);
    }
    // (y1 + y2) * (t1 + t2)
    let y1 = set_lo(y, 0);
    let p_l = (y - y1) * t1 + y * t2;
    let mut p_h = y1 * t1;
    let mut z = p_l + p_h;
    let j = hi(z);
    let i = lo(z) as i32;
    if j >= 0x40900000 {
        // z >= 1024
        if ((j - 0x40900000) | i) != 0 {
            return s * HUGE * HUGE;
        } else if p_l + OVT > z - p_h {
            return s * HUGE * HUGE;
        }
    } else if (j & 0x7fffffff) >= 0x4090cc00 {
        // z <= -1075
        if ((j as u32).wrapping_sub(0xc090cc00) as i32 | i) != 0 {
            return s * TINY * TINY;
        } else if p_l <= z - p_h {
            return s * TINY * TINY;
        }
    }
    // 2**(p_h + p_l)
    let i = j & 0x7fffffff;
    let mut k = (i >> 20) - 0x3ff;
    let mut n: i32 = 0;
    if i > 0x3fe00000 {
        n = j + (0x00100000 >> (k + 1));
        k = ((n & 0x7fffffff) >> 20) - 0x3ff;
        let t = from_words(n & !(0x000fffff >> k), 0);
        n = ((n & 0x000fffff) | 0x00100000) >> (20 - k);
        if j < 0 {
            n = -n;
        }
        p_h -= t;
    }
    let t = set_lo(p_l + p_h, 0);
    let u = t * LG2_H;
    let v = (p_l - (t - p_h)) * LG2 + t * LG2_L;
    z = u + v;
    let w = v - (z - u);
    let t = z * z;
    let t1 = z - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    let r = (z * t1) / (t1 - 2.0) - (w + z * w);
    z = 1.0 - (r - z);
    let mut jj = hi(z);
    jj += n << 20;
    if (jj >> 20) <= 0 {
        z = scalbn(z, n); // subnormal output
    } else {
        z = with_hi(z, hi(z) + (n << 20));
    }
    s * z
}

/// Math.pow: V8 calls the platform's pow (with ECMAScript's NaN for ±1 ** ±Infinity), so the reference
/// itself differs by a last bit between operating systems. The engine uses one pure-Rust pow (the `libm`
/// crate, the one WebAssembly builds link for powf), so native and WebAssembly agree everywhere.
pub fn pow(x: f64, y: f64) -> f64 {
    if y.is_nan() || (y.is_infinite() && (x == 1.0 || x == -1.0)) {
        return f64::NAN;
    }
    libm::pow(x, y)
}

/// fdlibm scalbn
fn scalbn(x: f64, n: i32) -> f64 {
    const TWO54: f64 = 1.80143985094819840000e+16;
    const TWOM54: f64 = 5.55111512312578270212e-17;
    const HUGE: f64 = 1.0e+300;
    const TINY: f64 = 1.0e-300;
    let mut x = x;
    let mut hx = hi(x);
    let lx = lo(x);
    let mut k = (hx & 0x7ff00000) >> 20;
    if k == 0 {
        if (lx | (hx & 0x7fffffff) as u32) == 0 {
            return x;
        }
        x *= TWO54;
        hx = hi(x);
        k = ((hx & 0x7ff00000) >> 20) - 54;
        if n < -50000 {
            return TINY * x;
        }
    }
    if k == 0x7ff {
        return x + x;
    }
    k += n;
    if k > 0x7fe {
        return HUGE * HUGE.copysign(x);
    }
    if k > 0 {
        return with_hi(x, (hx & -0x7ff00001) | (k << 20));
    }
    if k <= -54 {
        if n > 50000 {
            return HUGE * HUGE.copysign(x);
        } else {
            return TINY * TINY.copysign(x);
        }
    }
    k += 54;
    with_hi(x, (hx & -0x7ff00001) | (k << 20)) * TWOM54
}

fn kernel_sin(x: f64, y: f64, iy: i32) -> f64 {
    const S1: f64 = -1.66666666666666324348e-01;
    const S2: f64 = 8.33333333332248946124e-03;
    const S3: f64 = -1.98412698298579493134e-04;
    const S4: f64 = 2.75573137070700676789e-06;
    const S5: f64 = -2.50507602534068634195e-08;
    const S6: f64 = 1.58969099521155010221e-10;
    let ix = hi(x) & 0x7fffffff;
    if ix < 0x3e400000 && (x as i32) == 0 {
        return x;
    }
    let z = x * x;
    let v = z * x;
    let r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
    if iy == 0 {
        x + v * (S1 + z * r)
    } else {
        x - ((z * (0.5 * y - v * r) - y) - v * S1)
    }
}

fn kernel_cos(x: f64, y: f64) -> f64 {
    const C1: f64 = 4.16666666666666019037e-02;
    const C2: f64 = -1.38888888888741095749e-03;
    const C3: f64 = 2.48015872894767294178e-05;
    const C4: f64 = -2.75573143513906633035e-07;
    const C5: f64 = 2.08757232129817482790e-09;
    const C6: f64 = -1.13596475577881948265e-11;
    let ix = hi(x) & 0x7fffffff;
    if ix < 0x3e400000 && (x as i32) == 0 {
        return 1.0;
    }
    let z = x * x;
    let r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
    if ix < 0x3FD33333 {
        1.0 - (0.5 * z - (z * r - x * y))
    } else {
        let qx = if ix > 0x3fe90000 { 0.28125 } else { from_words(ix - 0x00200000, 0) };
        let hz = 0.5 * z - qx;
        let a = 1.0 - qx;
        a - (hz - (z * r - x * y))
    }
}

const NPIO2_HW: [i32; 32] = [
    0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C, 0x4025FDBB, 0x402921FB, 0x402C463A, 0x402F6A7A, 0x4031475C, 0x4032D97C, 0x40346B9C, 0x4035FDBB, 0x40378FDB, 0x403921FB, 0x403AB41B, 0x403C463A, 0x403DD85A, 0x403F6A7A, 0x40407E4C,
    0x4041475C, 0x4042106C, 0x4042D97C, 0x4043A28C, 0x40446B9C, 0x404534AC, 0x4045FDBB, 0x4046C6CB, 0x40478FDB, 0x404858EB, 0x404921FB,
];

/// x reduced by multiples of pi/2 (|x| up to 2^19·pi/2; beyond that the platform's sin/cos answer)
fn rem_pio2(x: f64) -> Option<(i32, f64, f64)> {
    const INVPIO2: f64 = 6.36619772367581382433e-01;
    const PIO2_1: f64 = 1.57079632673412561417e+00;
    const PIO2_1T: f64 = 6.07710050650619224932e-11;
    const PIO2_2: f64 = 6.07710050630396597660e-11;
    const PIO2_2T: f64 = 2.02226624879595063154e-21;
    const PIO2_3: f64 = 2.02226624871116645580e-21;
    const PIO2_3T: f64 = 8.47842766036889956997e-32;
    let hx = hi(x);
    let ix = hx & 0x7fffffff;
    if ix <= 0x3fe921fb {
        return Some((0, x, 0.0));
    }
    if ix < 0x4002d97c {
        // |x| < 3pi/4: n = ±1
        if hx > 0 {
            let mut z = x - PIO2_1;
            if ix != 0x3ff921fb {
                let y0 = z - PIO2_1T;
                return Some((1, y0, (z - y0) - PIO2_1T));
            }
            z -= PIO2_2;
            let y0 = z - PIO2_2T;
            return Some((1, y0, (z - y0) - PIO2_2T));
        }
        let mut z = x + PIO2_1;
        if ix != 0x3ff921fb {
            let y0 = z + PIO2_1T;
            return Some((-1, y0, (z - y0) + PIO2_1T));
        }
        z += PIO2_2;
        let y0 = z + PIO2_2T;
        return Some((-1, y0, (z - y0) + PIO2_2T));
    }
    if ix <= 0x413921fb {
        let t = x.abs();
        let n = (t * INVPIO2 + 0.5) as i32;
        let fnn = n as f64;
        let mut r = t - fnn * PIO2_1;
        let mut w = fnn * PIO2_1T;
        let mut y0;
        if n < 32 && ix != NPIO2_HW[(n - 1) as usize] {
            y0 = r - w;
        } else {
            let j = ix >> 20;
            y0 = r - w;
            let i = j - ((hi(y0) >> 20) & 0x7ff);
            if i > 16 {
                let t = r;
                w = fnn * PIO2_2;
                r = t - w;
                w = fnn * PIO2_2T - ((t - r) - w);
                y0 = r - w;
                let i = j - ((hi(y0) >> 20) & 0x7ff);
                if i > 49 {
                    let t = r;
                    w = fnn * PIO2_3;
                    r = t - w;
                    w = fnn * PIO2_3T - ((t - r) - w);
                    y0 = r - w;
                }
            }
        }
        let y1 = (r - y0) - w;
        return Some(if hx < 0 { (-n, -y0, -y1) } else { (n, y0, y1) });
    }
    None
}

pub fn sin(x: f64) -> f64 {
    let ix = hi(x) & 0x7fffffff;
    if ix <= 0x3fe921fb {
        return kernel_sin(x, 0.0, 0);
    }
    if ix >= 0x7ff00000 {
        return x - x;
    }
    match rem_pio2(x) {
        Some((n, y0, y1)) => match n & 3 {
            0 => kernel_sin(y0, y1, 1),
            1 => kernel_cos(y0, y1),
            2 => -kernel_sin(y0, y1, 1),
            _ => -kernel_cos(y0, y1),
        },
        None => x.sin(),
    }
}

pub fn cos(x: f64) -> f64 {
    let ix = hi(x) & 0x7fffffff;
    if ix <= 0x3fe921fb {
        return kernel_cos(x, 0.0);
    }
    if ix >= 0x7ff00000 {
        return x - x;
    }
    match rem_pio2(x) {
        Some((n, y0, y1)) => match n & 3 {
            0 => kernel_cos(y0, y1),
            1 => -kernel_sin(y0, y1, 1),
            2 => -kernel_cos(y0, y1),
            _ => kernel_sin(y0, y1, 1),
        },
        None => x.cos(),
    }
}

/// the engine's transcendental functions: `x.js_ln()` where it wrote `x.ln()`
pub trait JsMath {
    fn js_ln(self) -> f64;
    fn js_exp(self) -> f64;
    fn js_pow(self, y: f64) -> f64;
    fn js_sin(self) -> f64;
    fn js_cos(self) -> f64;
}

impl JsMath for f64 {
    #[inline]
    fn js_ln(self) -> f64 {
        log(self)
    }
    #[inline]
    fn js_exp(self) -> f64 {
        exp(self)
    }
    #[inline]
    fn js_pow(self, y: f64) -> f64 {
        pow(self, y)
    }
    #[inline]
    fn js_sin(self) -> f64 {
        sin(self)
    }
    #[inline]
    fn js_cos(self) -> f64 {
        cos(self)
    }
}

#[cfg(test)]
mod v8 {
    /// FMATH_V8=<file of "fn a b result" bit patterns from node>: every value identical
    #[test]
    fn matches_v8() {
        let Ok(p) = std::env::var("FMATH_V8") else { return };
        let text = std::fs::read_to_string(p).unwrap();
        let mut bad: Vec<String> = vec![];
        let mut n = 0;
        for l in text.lines() {
            let v: Vec<&str> = l.split(' ').collect();
            let a = f64::from_bits(v[1].parse().unwrap());
            let b = f64::from_bits(v[2].parse().unwrap());
            let want: u64 = v[3].parse().unwrap();
            let got = match v[0] {
                "log" => super::log(a),
                "exp" => super::exp(a),
                "pow" => continue,
                "sin" => super::sin(a),
                _ => super::cos(a),
            };
            let same = got.to_bits() == want || (got.is_nan() && f64::from_bits(want).is_nan());
            if !same {
                bad.push(format!("{}({:e}, {:e}) = {:e}, v8 {:e}", v[0], a, b, got, f64::from_bits(want)));
            }
            n += 1;
        }
        assert!(bad.is_empty(), "{} of {} differ: {:?}", bad.len(), n, &bad[..bad.len().min(6)]);
    }
}
