(function () {
  'use strict';

  var reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  var coarsePointerQuery = window.matchMedia('(pointer: coarse)');

  function prefersReducedMotion() {
    return reducedMotionQuery.matches;
  }

  function initSmoothAnchors() {
    document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
      anchor.addEventListener('click', function (e) {
        var href = anchor.getAttribute('href');
        if (!href || href === '#') return;

        var target = document.querySelector(href);
        if (!target) return;

        e.preventDefault();
        target.scrollIntoView({
          behavior: prefersReducedMotion() ? 'auto' : 'smooth',
          block: 'start'
        });
      });
    });
  }

  function initOrbParallax() {
    if (prefersReducedMotion() || coarsePointerQuery.matches) return;

    var orbs = document.querySelectorAll('.orb');
    if (!orbs.length) return;

    orbs.forEach(function (orb) {
      orb.style.willChange = 'transform';
    });

    var rafId = null;
    var mouseX = 0;
    var mouseY = 0;

    document.addEventListener('mousemove', function (e) {
      mouseX = e.clientX;
      mouseY = e.clientY;
      if (rafId) return;

      rafId = requestAnimationFrame(function () {
        orbs.forEach(function (orb, index) {
          var speed = (index + 1) * 15;
          var xOffset = (window.innerWidth / 2 - mouseX) / speed;
          var yOffset = (window.innerHeight / 2 - mouseY) / speed;
          orb.style.transform = 'translate3d(' + xOffset + 'px, ' + yOffset + 'px, 0)';
        });
        rafId = null;
      });
    }, { passive: true });
  }

  function initVisibilityPause(selectors) {
    if (!selectors || !selectors.length) return;

    document.addEventListener('visibilitychange', function () {
      var state = document.hidden ? 'paused' : 'running';
      selectors.forEach(function (selector) {
        document.querySelectorAll(selector).forEach(function (el) {
          el.style.animationPlayState = state;
        });
      });
    });
  }

  initSmoothAnchors();
  initOrbParallax();

  window.GrowSitePerf = {
    initVisibilityPause: initVisibilityPause,
    prefersReducedMotion: prefersReducedMotion
  };
})();
