export const id = 157;
export const ids = [157];
export const modules = {

/***/ 71157:
/***/ ((__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) => {

/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   "default": () => (/* binding */ t)
/* harmony export */ });
/* harmony import */ var _chunk_CzB3_c9G_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(96934);

//#region ../node_modules/.pnpm/p-map@7.0.4/node_modules/p-map/index.js
async function t(e, t, { concurrency: r = Infinity, stopOnError: i = !0, signal: a } = {}) {
	return new Promise((o, s) => {
		if (e[Symbol.iterator] === void 0 && e[Symbol.asyncIterator] === void 0) throw TypeError(`Expected \`input\` to be either an \`Iterable\` or \`AsyncIterable\`, got (${typeof e})`);
		if (typeof t != "function") throw TypeError("Mapper function is required");
		if (!(Number.isSafeInteger(r) && r >= 1 || r === Infinity)) throw TypeError(`Expected \`concurrency\` to be an integer from 1 and up or \`Infinity\`, got \`${r}\` (${typeof r})`);
		let c = [], l = [], u = /* @__PURE__ */ new Map(), d = !1, f = !1, p = !1, m = 0, h = 0, g = e[Symbol.iterator] === void 0 ? e[Symbol.asyncIterator]() : e[Symbol.iterator](), _ = () => {
			b(a.reason);
		}, v = () => {
			a?.removeEventListener("abort", _);
		}, y = (e) => {
			o(e), v();
		}, b = (e) => {
			d = !0, f = !0, s(e), v();
		};
		a && (a.aborted && b(a.reason), a.addEventListener("abort", _, { once: !0 }));
		let x = async () => {
			if (f) return;
			let e = await g.next(), r = h;
			if (h++, e.done) {
				if (p = !0, m === 0 && !f) {
					if (!i && l.length > 0) {
						b(AggregateError(l));
						return;
					}
					if (f = !0, u.size === 0) {
						y(c);
						return;
					}
					let e = [];
					for (let [t, r] of c.entries()) u.get(t) !== n && e.push(r);
					y(e);
				}
				return;
			}
			m++, (async () => {
				try {
					let i = await e.value;
					if (f) return;
					let a = await t(i, r);
					a === n && u.set(r, a), c[r] = a, m--, await x();
				} catch (e) {
					if (i) b(e);
					else {
						l.push(e), m--;
						try {
							await x();
						} catch (e) {
							b(e);
						}
					}
				}
			})();
		};
		(async () => {
			for (let e = 0; e < r; e++) {
				try {
					await x();
				} catch (e) {
					b(e);
					break;
				}
				if (p || d) break;
			}
		})();
	});
}
var n;
//#endregion
(0,_chunk_CzB3_c9G_js__WEBPACK_IMPORTED_MODULE_0__.n)((() => {
	n = Symbol("skip");
}))();


//# sourceMappingURL=p-map-ZBbt7AKN.js.map

/***/ })

};
