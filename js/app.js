(function () {
    'use strict';

    const CANVAS_SIZE = 600;          // Internal canvas resolution
    const MAX_PIN_RADIUS = 40;        // Max pin radius (px)
    const MIN_PIN_GAP = 12;           // Min gap between adjacent pin edges
    const CLOSURE_THRESHOLD = 30;     // Distance to auto-close loop
    const MIN_PINS_TO_CLOSE = 1;      // Min captured pins before closure
    const MIN_TRAVEL_TO_CLOSE = 100;  // Min path travel before closure (px)

    const COLORS = {
      pin:          '#d8dae0',
      pinCaptured:  '#e63946',
      string:       '#e63946',
      stringGlow:   'rgba(230, 57, 70, 0.25)',
      startDot:     'rgba(230, 57, 70, 0.35)',
      startRing:    '#e63946',
      closureHint:  'rgba(46, 204, 113, 0.4)',
      ghostShape:   'rgba(0, 0, 0, 0.08)',
      ghostStroke:  'rgba(0, 0, 0, 0.15)',
      shape:        '#000000'
    };

    const canvasOp  = document.getElementById('canvas-op');
    const ctxOp     = canvasOp.getContext('2d');
    const canvasRes = document.getElementById('canvas-res');
    const ctxRes    = canvasRes.getContext('2d');
    const wrapOp    = document.getElementById('wrap-op');
    const wrapRes   = document.getElementById('wrap-res');
    const elStatus  = document.getElementById('status');
    const elCounter = document.getElementById('pin-counter');
    const elArea    = document.getElementById('area-display');
    const inputRows = document.getElementById('input-rows');
    const inputCols = document.getElementById('input-cols');
    const btnUndo   = document.getElementById('btn-undo');
    const btnReset  = document.getElementById('btn-reset');
    const btnExport = document.getElementById('btn-export');

    let pins            = [];       // Array of pin objects {x, y, id, captured}
    let rows            = 4;
    let cols            = 4;
    let isDrawing       = false;
    let startPoint      = null;     // {x, y} — where the drag began
    let mousePos        = { x: 0, y: 0 };
    let prevMousePos    = { x: 0, y: 0 };
    let capturedPins    = [];       // [{pin, wrapDir: 'cw'|'ccw'}, ...]
    let totalTravel     = 0;        // Total distance traveled during drag
    let completedShapes = [];       // Array of segment arrays for finished shapes
    let isClosed        = false;
    let pinRadius       = MAX_PIN_RADIUS;  // Dynamic — recalculated on grid change
    let captureRadius   = 52;              // Dynamic — pinRadius + margin

    function segmentCircleIntersectionT(A, B, C, R) {
      const Vx = B.x - A.x;
      const Vy = B.y - A.y;
      const Wx = A.x - C.x;
      const Wy = A.y - C.y;

      const a = Vx*Vx + Vy*Vy;
      if (a === 0) return null;

      const b = 2 * (Vx*Wx + Vy*Wy);
      const c = Wx*Wx + Wy*Wy - R*R;

      const delta = b*b - 4*a*c;
      if (delta < 0) return null;

      const sqrtDelta = Math.sqrt(delta);
      const t1 = (-b - sqrtDelta) / (2*a);
      const t2 = (-b + sqrtDelta) / (2*a);

      let minT = null;
      if (t1 >= 0 && t1 <= 1) minT = t1;
      if (t2 >= 0 && t2 <= 1) {
        if (minT === null || t2 < minT) minT = t2;
      }
      return minT;
    }

    function distToSegment(P, A, B) {
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const l2 = dx*dx + dy*dy;
      if (l2 === 0) return Math.hypot(P.x - A.x, P.y - A.y);

      let t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / l2;
      t = Math.max(0, Math.min(1, t));

      const projX = A.x + t * dx;
      const projY = A.y + t * dy;
      return Math.hypot(P.x - projX, P.y - projY);
    }

    function getWrapSide(A, pin, P) {
      const dx = pin.x - A.x;
      const dy = pin.y - A.y;
      const pdx = P.x - A.x;
      const pdy = P.y - A.y;
      return (dx * pdy - dy * pdx) < 0 ? -1 : 1; 
    }

    function computeTautPath(start, captured, pos) {
      const segments = [];
      if (captured.length === 0) {
        segments.push({ type: 'line', from: {x: start.x, y: start.y}, to: {x: pos.x, y: pos.y} });
        return segments;
      }

      const entryAngles = [];
      const exitAngles = [];

      for (let i = 0; i < captured.length; i++) {
        const wrap = captured[i];
        const pin = wrap.pin;
        const side = wrap.side;

        if (i === 0) {
          const dx = pin.x - start.x;
          const dy = pin.y - start.y;
          const dist = Math.hypot(dx, dy);
          if (dist > pinRadius) {
            const alpha = Math.acos(pinRadius / dist);
            const theta = Math.atan2(-dy, -dx);
            entryAngles[i] = theta - side * alpha;
          } else {
            entryAngles[i] = Math.atan2(-dy, -dx);
          }
        } else {
          const prevWrap = captured[i-1];
          const dx = pin.x - prevWrap.pin.x;
          const dy = pin.y - prevWrap.pin.y;
          const D = Math.hypot(dx, dy);
          const theta = Math.atan2(dy, dx);

          if (prevWrap.side === side) {
            entryAngles[i] = theta + side * Math.PI/2;
          } else {
            const alpha = Math.acos(2 * pinRadius / D);
            entryAngles[i] = theta + Math.PI - side * alpha;
          }
        }

        if (i === captured.length - 1) {
          const dx = pos.x - pin.x;
          const dy = pos.y - pin.y;
          const dist = Math.hypot(dx, dy);
          if (dist > pinRadius) {
            const alpha = Math.acos(pinRadius / dist);
            const theta = Math.atan2(dy, dx);
            exitAngles[i] = theta + side * alpha;
          } else {
            exitAngles[i] = Math.atan2(dy, dx);
          }
        } else {
          const nextWrap = captured[i+1];
          const dx = nextWrap.pin.x - pin.x;
          const dy = nextWrap.pin.y - pin.y;
          const D = Math.hypot(dx, dy);
          const theta = Math.atan2(dy, dx);

          if (side === nextWrap.side) {
            exitAngles[i] = theta + side * Math.PI/2;
          } else {
            const alpha = Math.acos(2 * pinRadius / D);
            exitAngles[i] = theta + side * alpha;
          }
        }
      }

      let curPos = { x: start.x, y: start.y };
      for (let i = 0; i < captured.length; i++) {
        const pin = captured[i].pin;
        const side = captured[i].side;
        const entryAngle = entryAngles[i];
        const exitAngle = exitAngles[i];

        const entry = {
          x: pin.x + pinRadius * Math.cos(entryAngle),
          y: pin.y + pinRadius * Math.sin(entryAngle)
        };
        const exit = {
          x: pin.x + pinRadius * Math.cos(exitAngle),
          y: pin.y + pinRadius * Math.sin(exitAngle)
        };

        segments.push({ type: 'line', from: curPos, to: entry });

        segments.push({
          type: 'arc',
          cx: pin.x,
          cy: pin.y,
          r: pinRadius,
          startAngle: entryAngle,
          endAngle: exitAngle,
          ccw: side === 1
        });

        curPos = exit;
      }

      segments.push({ type: 'line', from: curPos, to: {x: pos.x, y: pos.y} });
      return segments;
    }

    function getTrueTangent(C, side, pos) {
      const dx = pos.x - C.x;
      const dy = pos.y - C.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= pinRadius) return C;
      const alpha = Math.acos(pinRadius / dist);
      const theta = Math.atan2(dy, dx);
      const angle = theta + side * alpha;
      return {
        x: C.x + pinRadius * Math.cos(angle),
        y: C.y + pinRadius * Math.sin(angle)
      };
    }

    function updateString(pos, prevPos) {
      let changed = true;
      let iterations = 0;

      while (changed && iterations < 15) {
        changed = false;
        iterations++;

        if (capturedPins.length > 0) {
          const last = capturedPins[capturedPins.length - 1];
          let prevAnchor = startPoint;
          if (capturedPins.length > 1) {
             const prevWrap = capturedPins[capturedPins.length - 2];
             prevAnchor = getTrueTangent(prevWrap.pin, prevWrap.side, pos);
          }

          const dist = distToSegment(last.pin, prevAnchor, pos);
          let unwrapped = false;
          if (dist >= pinRadius + 0.1) {
            const currentSide = getWrapSide(prevAnchor, last.pin, pos);
            if (currentSide === last.side) {
              unwrapped = true;
            }
          } 

          if (unwrapped) {
            capturedPins.pop();
            last.pin.captured = false;
            changed = true;
            continue;
          }
        }

        let A = startPoint;
        if (capturedPins.length > 0) {
           const last = capturedPins[capturedPins.length - 1];
           A = getTrueTangent(last.pin, last.side, pos);
        }
        let hitPin = null;
        let minT = 1.0;

        for (const pin of pins) {
          if (pin.captured) continue;

          const t = segmentCircleIntersectionT(A, pos, pin, pinRadius - 0.5);
          if (t !== null && t < minT) {
            minT = t;
            hitPin = pin;
          }
        }

        if (hitPin) {
          hitPin.captured = true;

          const side = getWrapSide(A, hitPin, prevPos || pos);
          capturedPins.push({ pin: hitPin, side: side });
          changed = true;
        }
      }
    }

    function buildGrid() {
      pins = [];
      const cellW = CANVAS_SIZE / cols;
      const cellH = CANVAS_SIZE / rows;

      const minSpacing = Math.min(cellW, cellH);
      pinRadius = Math.min(Math.floor((minSpacing - MIN_PIN_GAP) / 2), MAX_PIN_RADIUS);

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cx = c * cellW + cellW / 2;
          const cy = r * cellH + cellH / 2;
          pins.push({
            id: r + '-' + c,
            x: cx,
            y: cy,
            captured: false
          });
        }
      }
    }

    function getCanvasCoords(e) {
      const rect = canvasOp.getBoundingClientRect();
      let clientX = e.clientX;
      let clientY = e.clientY;
      if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      }
      const scaleX = canvasOp.width / rect.width;
      const scaleY = canvasOp.height / rect.height;
      return {
        x: (clientX - rect.left) * scaleX,
        y: (clientY - rect.top) * scaleY
      };
    }

    function handleStart(e) {
      e.preventDefault();
      if (isClosed) return;

      const pos = getCanvasCoords(e);
      isDrawing = true;
      startPoint = { x: pos.x, y: pos.y };
      mousePos = { x: pos.x, y: pos.y };
      prevMousePos = { x: pos.x, y: pos.y };
      totalTravel = 0;
      capturedPins = [];
      pins.forEach(p => p.captured = false);

      updateStatus('drawing');
      updateCounter();
    }

    function handleMove(e) {
      e.preventDefault();
      if (!isDrawing) return;

      const pos = getCanvasCoords(e);
      const prevPos = { x: mousePos.x, y: mousePos.y };
      mousePos = { x: pos.x, y: pos.y };

      const stepDist = Math.hypot(pos.x - prevPos.x, pos.y - prevPos.y);
      totalTravel += stepDist;

      updateString(mousePos, prevPos);
      updateCounter();

      if (startPoint
          && capturedPins.length >= MIN_PINS_TO_CLOSE
          && totalTravel > MIN_TRAVEL_TO_CLOSE) {
        const distToStart = Math.hypot(pos.x - startPoint.x, pos.y - startPoint.y);
        if (distToStart < CLOSURE_THRESHOLD) {
          closeLoop();
        }
      }

      prevMousePos = { x: pos.x, y: pos.y };
    }

    function handleEnd(e) {
      e.preventDefault();
      if (!isDrawing) return;

      if (startPoint
          && capturedPins.length >= MIN_PINS_TO_CLOSE
          && totalTravel > MIN_TRAVEL_TO_CLOSE) {
        const pos = getCanvasCoords(e);
        const distToStart = Math.hypot(pos.x - startPoint.x, pos.y - startPoint.y);
        if (distToStart < CLOSURE_THRESHOLD * 1.5) {
          closeLoop();
          return;
        }
      }

      isDrawing = false;
      startPoint = null;
      capturedPins = [];
      pins.forEach(p => p.captured = false);
      updateStatus('idle');
      updateCounter();
    }

    function computeClosedPath(captured) {
      const segments = [];
      const N = captured.length;

      if (N === 0) return segments;
      if (N === 1) {
        const pin = captured[0].pin;
        segments.push({
          type: 'arc',
          cx: pin.x,
          cy: pin.y,
          r: pinRadius,
          startAngle: 0,
          endAngle: 2 * Math.PI,
          ccw: false
        });
        return segments;
      }

      const entryAngles = new Array(N);
      const exitAngles = new Array(N);

      for (let i = 0; i < N; i++) {
        const wrap1 = captured[i];
        const wrap2 = captured[(i + 1) % N];

        const dx = wrap2.pin.x - wrap1.pin.x;
        const dy = wrap2.pin.y - wrap1.pin.y;
        const D = Math.hypot(dx, dy);
        const theta = Math.atan2(dy, dx);

        if (wrap1.side === wrap2.side) {
          exitAngles[i] = theta + wrap1.side * Math.PI/2;
          entryAngles[(i + 1) % N] = theta + wrap2.side * Math.PI/2;
        } else {
          const alpha = Math.acos(2 * pinRadius / D);
          exitAngles[i] = theta + wrap1.side * alpha;
          entryAngles[(i + 1) % N] = theta + Math.PI - wrap2.side * alpha;
        }
      }

      let curPos = null;
      for (let i = 0; i < N; i++) {
        const pin = captured[i].pin;
        const side = captured[i].side;
        const entryAngle = entryAngles[i];
        const exitAngle = exitAngles[i];

        const entry = {
          x: pin.x + pinRadius * Math.cos(entryAngle),
          y: pin.y + pinRadius * Math.sin(entryAngle)
        };
        const exit = {
          x: pin.x + pinRadius * Math.cos(exitAngle),
          y: pin.y + pinRadius * Math.sin(exitAngle)
        };

        if (curPos !== null) {
          segments.push({ type: 'line', from: curPos, to: entry });
        }

        segments.push({
          type: 'arc',
          cx: pin.x,
          cy: pin.y,
          r: pinRadius,
          startAngle: entryAngle,
          endAngle: exitAngle,
          ccw: side === 1
        });

        curPos = exit;
      }

      const firstEntryAngle = entryAngles[0];
      const firstPin = captured[0].pin;
      const firstEntry = {
        x: firstPin.x + pinRadius * Math.cos(firstEntryAngle),
        y: firstPin.y + pinRadius * Math.sin(firstEntryAngle)
      };
      segments.push({ type: 'line', from: curPos, to: firstEntry });

      return segments;
    }

    function closeLoop() {
      if (isClosed) return;

      const segments = computeClosedPath(capturedPins);
      completedShapes.push(segments);

      const shapeArea = calculateArea(segments);
      const totalArea = CANVAS_SIZE * CANVAS_SIZE;
      const pct = (shapeArea / totalArea * 100).toFixed(1);
      elArea.textContent = 'Area: ' + pct + '% of canvas';

      renderResultCanvas();

      wrapOp.classList.add('success-flash');
      setTimeout(() => wrapOp.classList.remove('success-flash'), 1200);

      isDrawing = false;
      isClosed = true;
      updateStatus('closed');

      if (window.innerWidth <= 960) {
        const resultPanel = document.getElementById('panel-res');
        if (resultPanel) {
          resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }

      setTimeout(() => {
        isClosed = false;
        startPoint = null;
        capturedPins = [];
        pins.forEach(p => p.captured = false);
        updateStatus('idle');
        updateCounter();
      }, 1200);
    }

    function updateStatus(state) {
      elStatus.className = '';
      switch (state) {
        case 'idle':
          elStatus.className = 'status-idle';
          elStatus.textContent = 'Ready';
          break;
        case 'drawing':
          elStatus.className = 'status-drawing';
          elStatus.textContent = 'Wrapping...';
          break;
        case 'closed':
          elStatus.className = 'status-closed';
          elStatus.textContent = 'Perfectly closed!';
          break;
      }
    }

    function updateCounter() {
      const count = capturedPins.length;
      elCounter.textContent = 'Wrapped pins: ' + count;
    }

    function onGridChange() {
      const newRows = Math.max(2, Math.min(10, parseInt(inputRows.value) || 4));
      const newCols = Math.max(2, Math.min(10, parseInt(inputCols.value) || 4));
      inputRows.value = newRows;
      inputCols.value = newCols;

      rows = newRows;
      cols = newCols;

      onReset();
    }

    function onUndo() {
      if (isDrawing && capturedPins.length > 0) {

        const removed = capturedPins.pop();
        removed.pin.captured = false;
        updateCounter();
      } else if (!isDrawing && completedShapes.length > 0) {

        completedShapes.pop();
        renderResultCanvas();
        if (completedShapes.length === 0) {
          elArea.textContent = '';
        }
      }
    }

    function onReset() {
      isDrawing = false;
      isClosed = false;
      startPoint = null;
      capturedPins = [];
      completedShapes = [];
      totalTravel = 0;
      elArea.textContent = '';

      buildGrid();
      renderResultCanvas();
      updateStatus('idle');
      updateCounter();
    }

    function onExport() {
      if (completedShapes.length === 0) return;

      const exportSize = CANVAS_SIZE * 2;
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = exportSize;
      exportCanvas.height = exportSize;
      const exportCtx = exportCanvas.getContext('2d');

      exportCtx.save();
      exportCtx.scale(2, 2);
      for (const shape of completedShapes) {
        drawPathOnCtx(exportCtx, shape, null, COLORS.shape);
      }
      exportCtx.restore();

      const link = document.createElement('a');
      link.download = 'hofmann-forma.png';
      link.href = exportCanvas.toDataURL('image/png');
      link.click();
    }

    function drawPathOnCtx(ctx, segments, strokeColor, fillColor) {
      if (segments.length === 0) return;

      ctx.beginPath();
      const first = segments[0];
      if (first.type === 'line') {
        ctx.moveTo(first.from.x, first.from.y);
      } else {
        const sx = first.cx + first.r * Math.cos(first.startAngle);
        const sy = first.cy + first.r * Math.sin(first.startAngle);
        ctx.moveTo(sx, sy);
      }

      for (const seg of segments) {
        if (seg.type === 'line') {
          ctx.lineTo(seg.to.x, seg.to.y);
        } else if (seg.type === 'arc') {
          ctx.arc(seg.cx, seg.cy, seg.r, seg.startAngle, seg.endAngle, seg.ccw);
        }
      }

      if (fillColor) {
        ctx.closePath();
        ctx.fillStyle = fillColor;
        ctx.fill();
      }
      if (strokeColor) {
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
      }
    }

    function calculateArea(segments) {

      let pts = [];
      if (segments.length === 0) return 0;

      const first = segments[0];
      if (first.type === 'line') pts.push(first.from);
      else {
        pts.push({
          x: first.cx + first.r * Math.cos(first.startAngle),
          y: first.cy + first.r * Math.sin(first.startAngle)
        });
      }

      for (const seg of segments) {
        if (seg.type === 'line') {
          pts.push(seg.to);
        } else if (seg.type === 'arc') {
          let steps = 10;
          let diff = seg.endAngle - seg.startAngle;
          if (seg.ccw && diff > 0) diff -= 2 * Math.PI;
          if (!seg.ccw && diff < 0) diff += 2 * Math.PI;
          for (let i = 1; i <= steps; i++) {
            let a = seg.startAngle + diff * (i / steps);
            pts.push({
              x: seg.cx + seg.r * Math.cos(a),
              y: seg.cy + seg.r * Math.sin(a)
            });
          }
        }
      }

      let area = 0;
      for (let i = 0; i < pts.length; i++) {
        let j = (i + 1) % pts.length;
        area += pts[i].x * pts[j].y;
        area -= pts[j].x * pts[i].y;
      }
      return Math.abs(area) / 2;
    }

    function renderResultCanvas() {
      ctxRes.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
      for (const shape of completedShapes) {
        drawPathOnCtx(ctxRes, shape, null, COLORS.shape);
      }
    }

    function render() {
      ctxOp.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

      for (const pin of pins) {
        ctxOp.beginPath();
        ctxOp.arc(pin.x, pin.y, pinRadius, 0, 2*Math.PI);
        ctxOp.fillStyle = COLORS.pin;
        ctxOp.fill();

        if (pin.captured) {
          ctxOp.beginPath();
          ctxOp.arc(pin.x, pin.y, 4, 0, 2*Math.PI);
          ctxOp.fillStyle = COLORS.string;
          ctxOp.fill();
        }
      }

      if (isDrawing && startPoint) {
        const segments = computeTautPath(startPoint, capturedPins, mousePos);
        drawPathOnCtx(ctxOp, segments, COLORS.string, null);
      }

      requestAnimationFrame(render);
    }

    function init() {

      buildGrid();

      canvasOp.addEventListener('mousedown',  handleStart);
      canvasOp.addEventListener('mousemove',  handleMove);
      canvasOp.addEventListener('mouseup',    handleEnd);
      canvasOp.addEventListener('mouseleave', handleEnd);

      canvasOp.addEventListener('touchstart', handleStart, { passive: false });
      canvasOp.addEventListener('touchmove',  handleMove,  { passive: false });
      canvasOp.addEventListener('touchend',   handleEnd,   { passive: false });
      canvasOp.addEventListener('touchcancel',handleEnd,   { passive: false });

      inputRows.addEventListener('change', onGridChange);
      inputCols.addEventListener('change', onGridChange);
      btnUndo.addEventListener('click', onUndo);
      btnReset.addEventListener('click', onReset);
      btnExport.addEventListener('click', onExport);

      document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
          e.preventDefault();
          onUndo();
        } else if (e.key === 'Escape') {
          onReset();
        }
      });

      canvasOp.addEventListener('contextmenu', (e) => e.preventDefault());

      requestAnimationFrame(render);
    }

    init();
  })();
