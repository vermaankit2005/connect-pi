// Runs before the first paint, on purpose: reading the saved theme in app.js
// would show a flash of the wrong colour on every launch. "system" writes no
// attribute at all and lets the CSS media query decide.
(function () {
	try {
		var size = Number(localStorage.getItem("connect-pi.textSize"));
        var version = localStorage.getItem("connect-pi.scaleVersion");
        var sizes = [13.44, 14.4, 15.36, 16.32, 17.28];
        var previous = version === "3" ? [13.16, 14.1, 15.04, 15.98, 16.92] : version === "2" ? [12.5, 13.5, 14.5, 15.5, 16.5] : [14, 15, 16, 17, 18];
        var index = previous.indexOf(size);
        if (version !== "4" && index !== -1) size = sizes[index];
        if (sizes.indexOf(size) !== -1) document.documentElement.style.fontSize = size + "px";
        var t = localStorage.getItem("connect-pi.theme");
		if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
	} catch (e) {}
})();
