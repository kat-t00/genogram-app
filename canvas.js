// SVGキャンバス：ノードの描画・ドラッグ移動・関係線の描画（種類ごとに見た目を変える）・
// 同居家族の点線囲みを担当する。
// （Pythonのcanvas_view.py + person_node_item.py + relationship_line_item.py +
//   institution_node_item.py + cohabiting_boundary_item.pyに相当）

(function (Genogram) {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const NODE_SIZE = 80;
  const LABEL_OFFSET = NODE_SIZE / 2 + 18;
  const INSTITUTION_W = 140;
  const INSTITUTION_H = 60;
  const ARROW_SIZE = 10;
  const PARALLEL_OFFSET = 4;
  // 同居家族の枠線（世帯全体）そのものを関係線の接続先にできるようにするための
  // 固定ID。グループと同じ仕組み（groupCenters）に重心を登録して解決する。
  const COHABITING_BOUNDARY_ID = "cohabiting_boundary";

  const GENDER_COLOR = {
    [Genogram.Gender.MALE]: "#4ecdc4",
    [Genogram.Gender.FEMALE]: "#a18cd1",
    [Genogram.Gender.UNKNOWN]: "#8a9bb5",
  };

  let svg = null;
  let viewportGroup = null; // パン・ズーム用に全レイヤーをまとめて包むグループ
  let layerCohabiting = null;
  let layerGroups = null;
  let layerLines = null;
  let layerNodes = null;
  let layerInteraction = null;

  // 画面のパン・ズーム状態。再描画(renderDocument)をまたいで保持する。
  // 画面上の座標 = viewTransform.x + viewTransform.scale * SVG内部座標
  const viewTransform = { x: 0, y: 0, scale: 1 };
  const MIN_SCALE = 0.2;
  const MAX_SCALE = 3;

  // 図形内テキスト（名前・続柄など）の文字サイズ倍率。ユーザーがボタンで調整できる。
  let fontScale = 1;
  const MIN_FONT_SCALE = 0.7;
  const MAX_FONT_SCALE = 2;
  let onFontScaleChange = null;
  // font-size属性に渡す値をfontScale倍して返す（元のpx値はそのままの見た目基準）
  function scaledFontSize(basePx) {
    return String(Math.round(basePx * fontScale * 10) / 10);
  }

  let currentDocument = null;
  const personGroups = {}; // personId -> <g>
  const institutionGroups = {}; // institutionId -> <g>
  const groupCenters = {}; // groupId -> {x,y}（メンバーの中心点の重心）
  const groupHulls = {}; // groupId -> [{x,y}, ...]（枠線の凸包の頂点。関係線を枠の縁で止めるために使う）
  const relationshipLines = {}; // relationshipId -> {group, a, b, link}
  const institutionLinkLines = {}; // linkId -> {group, a, b, link}
  let familyTreeConnectors = []; // [{element, group}] 結婚線→兄弟バー→各子の樹形図コネクタ
  let cohabitingPath = null; // 見た目用（背面）。対象者だけを囲む滑らかな閉曲線
  let cohabitingPathHit = null; // 移動操作の当たり判定用（最前面、見た目と同じ形）
  let cohabitingHandlesGroup = null; // 同居枠の輪郭を変形する操作用の丸（最前面）

  // 同居枠・グループ枠の輪郭を「重心から12方向に伸ばした点」として表現する。
  // 凸包そのものの頂点を編集対象にすると、メンバーの人数・配置が変わるたびに
  // 頂点の数や位置が変わってしまい、ユーザーが変形した内容を保持できない。
  // 固定12方向の半径（自動計算した形からの増減）として保存することで、
  // メンバーが増減・移動しても「ここだけ凹ませた」という調整が保たれる。
  const SHAPE_ANGLE_STEPS = 12;
  const SHAPE_MIN_RADIUS = 24;
  const SHAPE_MAX_RADIUS = 500;

  let onLineContextMenu = null; // app.jsから登録される (link, clientX, clientY) => void
  let onPersonClick = null; // forms.jsから登録される (person) => void
  let onInstitutionClick = null; // forms.jsから登録される (institution) => void
  let onGroupClick = null; // forms.jsから登録される (group) => void
  let onDragEnd = null; // app.jsから登録される () => void。ドラッグで位置を変えた後の保存トリガー用
  let onCanvasBackgroundClick = null; // app.jsから登録される (clientX, clientY) => void
  const CLICK_MOVE_THRESHOLD = 4; // これ未満の移動量ならドラッグではなくクリックとみなす

  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const key in attrs) el.setAttribute(key, attrs[key]);
    }
    return el;
  }

  function init(svgElement) {
    svg = svgElement;
    setupPanZoom();
  }

  // ===== 画面のパン（背景ドラッグ）・ズーム（ホイール）=====
  // ノード・線・枠など個別の図形のドラッグ操作は各図形側でstopPropagationしないため、
  // 「クリックした相手がsvg自体（=何もない背景）の場合だけパンを開始する」ことで
  // ノードのドラッグや枠の操作と衝突しないようにしている。

  function setupPanZoom() {
    svg.addEventListener("pointerdown", (evt) => {
      if (evt.target !== svg) return;
      const startClientX = evt.clientX;
      const startClientY = evt.clientY;
      const startTransform = { x: viewTransform.x, y: viewTransform.y };
      let moved = false;

      function onMove(moveEvt) {
        if (Math.hypot(moveEvt.clientX - startClientX, moveEvt.clientY - startClientY) > CLICK_MOVE_THRESHOLD) {
          moved = true;
        }
        viewTransform.x = startTransform.x + (moveEvt.clientX - startClientX);
        viewTransform.y = startTransform.y + (moveEvt.clientY - startClientY);
        applyViewTransform();
      }
      function onUp(upEvt) {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        // 左クリックで、ドラッグ(パン)せずにその場でボタンを離した場合だけ
        // 「何もない場所をクリックした」とみなしてクイックメニューを開く
        if (!moved && evt.button === 0 && onCanvasBackgroundClick) {
          onCanvasBackgroundClick(upEvt.clientX, upEvt.clientY);
        }
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });

    svg.addEventListener("contextmenu", (evt) => {
      if (evt.target !== svg) return;
      evt.preventDefault();
      if (onCanvasBackgroundClick) onCanvasBackgroundClick(evt.clientX, evt.clientY);
    });

    svg.addEventListener(
      "wheel",
      (evt) => {
        evt.preventDefault();
        const rect = svg.getBoundingClientRect();
        const screenX = evt.clientX - rect.left;
        const screenY = evt.clientY - rect.top;
        const worldBefore = screenToWorld(evt.clientX, evt.clientY);
        const factor = evt.deltaY < 0 ? 1.1 : 1 / 1.1;
        viewTransform.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, viewTransform.scale * factor));
        viewTransform.x = screenX - viewTransform.scale * worldBefore.x;
        viewTransform.y = screenY - viewTransform.scale * worldBefore.y;
        applyViewTransform();
      },
      { passive: false }
    );
  }

  let onZoomChange = null; // app.jsから登録される (scalePercent) => void。ズーム操作のたびに呼ばれる

  function setZoomChangeHandler(handler) {
    onZoomChange = handler;
    if (onZoomChange) onZoomChange(Math.round(viewTransform.scale * 100));
  }

  function applyViewTransform() {
    if (!viewportGroup) return;
    viewportGroup.setAttribute(
      "transform",
      `translate(${viewTransform.x}, ${viewTransform.y}) scale(${viewTransform.scale})`
    );
    if (onZoomChange) onZoomChange(Math.round(viewTransform.scale * 100));
  }

  // 画面の中心を基準にズームする（ホイールのズームはマウス位置基準だが、
  // ボタン操作では「今見ている場所の中心」を基準にする方が自然）。
  function zoomBy(factor) {
    const rect = svg.getBoundingClientRect();
    const screenX = rect.width / 2;
    const screenY = rect.height / 2;
    const worldBefore = screenToWorld(rect.left + screenX, rect.top + screenY);
    viewTransform.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, viewTransform.scale * factor));
    viewTransform.x = screenX - viewTransform.scale * worldBefore.x;
    viewTransform.y = screenY - viewTransform.scale * worldBefore.y;
    applyViewTransform();
  }

  // 表示の基準となる「100%」（スケール1）に、画面中心を基準に戻す。
  function resetZoomToActual() {
    zoomBy(1 / viewTransform.scale);
  }

  // 画面上のクリック座標(clientX/Y)を、現在のパン・ズームを差し引いた
  // SVG内部座標（person.x/yなどと同じ座標系）に変換する。
  function screenToWorld(clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    const screenX = clientX - rect.left;
    const screenY = clientY - rect.top;
    return {
      x: (screenX - viewTransform.x) / viewTransform.scale,
      y: (screenY - viewTransform.y) / viewTransform.scale,
    };
  }

  // 今の表示範囲（パン・ズーム後）が、ワールド座標でどの範囲を映しているかを求める。
  // 新しく追加した人物・関係機関が画面外に出てしまっていないかを判定するのに使う。
  function getVisibleWorldBounds() {
    const rect = svg.getBoundingClientRect();
    const topLeft = screenToWorld(rect.left, rect.top);
    const bottomRight = screenToWorld(rect.right, rect.bottom);
    return { minX: topLeft.x, minY: topLeft.y, maxX: bottomRight.x, maxY: bottomRight.y };
  }

  function isWorldPointVisible(x, y, margin) {
    const m = margin || 0;
    const b = getVisibleWorldBounds();
    return x >= b.minX - m && x <= b.maxX + m && y >= b.minY - m && y <= b.maxY + m;
  }

  function resetView() {
    viewTransform.x = 0;
    viewTransform.y = 0;
    viewTransform.scale = 1;
    applyViewTransform();
  }

  // 現在登録されている人物・関係機関すべてを含む境界（ワールド座標）を求める。
  // 何も登録されていない場合はnullを返す。
  function computeContentBounds(doc) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    doc.persons.forEach((p) => {
      const half = NODE_SIZE / 2;
      minX = Math.min(minX, p.x - half); maxX = Math.max(maxX, p.x + half);
      minY = Math.min(minY, p.y - half); maxY = Math.max(maxY, p.y + half);
    });
    doc.institutions.forEach((i) => {
      minX = Math.min(minX, i.x - INSTITUTION_W / 2); maxX = Math.max(maxX, i.x + INSTITUTION_W / 2);
      minY = Math.min(minY, i.y - INSTITUTION_H / 2); maxY = Math.max(maxY, i.y + INSTITUTION_H / 2);
    });
    if (minX === Infinity) return null;
    return { minX, minY, maxX, maxY };
  }

  // 「全体を表示領域に収める」：内容物の境界に合わせてパン・ズームを自動調整する。
  function fitToView(doc) {
    const bounds = computeContentBounds(doc);
    if (!bounds) return;
    const rect = svg.getBoundingClientRect();
    const margin = 60;
    const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
    const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
    const FIT_MAX_SCALE = 1.5; // fitToView時は拡大しすぎないよう上限を絞る（手動ズームは最大MAX_SCALE=3まで可能）
    const scale = Math.min(
      FIT_MAX_SCALE,
      Math.max(MIN_SCALE, Math.min((rect.width - margin * 2) / contentWidth, (rect.height - margin * 2) / contentHeight))
    );
    const contentCenterX = (bounds.minX + bounds.maxX) / 2;
    const contentCenterY = (bounds.minY + bounds.maxY) / 2;
    viewTransform.scale = scale;
    viewTransform.x = rect.width / 2 - scale * contentCenterX;
    viewTransform.y = rect.height / 2 - scale * contentCenterY;
    applyViewTransform();
  }

  function setLineContextMenuHandler(handler) {
    onLineContextMenu = handler;
  }

  function setPersonClickHandler(handler) {
    onPersonClick = handler;
  }

  function setInstitutionClickHandler(handler) {
    onInstitutionClick = handler;
  }

  function setGroupClickHandler(handler) {
    onGroupClick = handler;
  }

  function setDragEndHandler(handler) {
    onDragEnd = handler;
  }

  // 表示モード："both"=ジェノグラム・エコマップ両方、"genogram"=家系図だけ、
  // "ecomap"=支援ネットワークだけ。データは変えず、svgへのCSSクラスで
  // 表示・非表示を切り替えるだけ（style.cssの.view-mode-*を参照）。
  function setViewMode(mode) {
    svg.classList.remove("view-mode-genogram", "view-mode-ecomap");
    if (mode === "genogram") svg.classList.add("view-mode-genogram");
    else if (mode === "ecomap") svg.classList.add("view-mode-ecomap");
  }

  function getViewMode() {
    if (svg.classList.contains("view-mode-genogram")) return "genogram";
    if (svg.classList.contains("view-mode-ecomap")) return "ecomap";
    return "both";
  }

  function setCanvasBackgroundClickHandler(handler) {
    onCanvasBackgroundClick = handler;
  }

  function renderDocument(doc) {
    currentDocument = doc;
    svg.innerHTML = "";
    viewportGroup = svgEl("g", { id: "viewport" });
    layerCohabiting = svgEl("g", { id: "layer-cohabiting" });
    layerGroups = svgEl("g", { id: "layer-groups" });
    layerLines = svgEl("g", { id: "layer-lines" });
    layerNodes = svgEl("g", { id: "layer-nodes" });
    layerInteraction = svgEl("g", { id: "layer-interaction" }); // 同居枠の操作（移動・リサイズ）は常に最前面で受け付ける
    svg.appendChild(viewportGroup);
    viewportGroup.appendChild(layerCohabiting);
    viewportGroup.appendChild(layerGroups);
    viewportGroup.appendChild(layerLines);
    viewportGroup.appendChild(layerNodes);
    viewportGroup.appendChild(layerInteraction);
    applyViewTransform();

    Object.keys(personGroups).forEach((k) => delete personGroups[k]);
    Object.keys(institutionGroups).forEach((k) => delete institutionGroups[k]);
    Object.keys(groupCenters).forEach((k) => delete groupCenters[k]);
    Object.keys(groupHulls).forEach((k) => delete groupHulls[k]);
    Object.keys(relationshipLines).forEach((k) => delete relationshipLines[k]);
    Object.keys(institutionLinkLines).forEach((k) => delete institutionLinkLines[k]);
    familyTreeConnectors = [];

    cohabitingPath = svgEl("path", {
      class: "cohabiting-boundary",
      fill: "rgba(190, 220, 255, 0.35)",
      stroke: "#7a8aa0",
      "stroke-width": "2",
      "stroke-dasharray": "6,5",
      "stroke-linejoin": "round",
      visibility: "hidden",
      "pointer-events": "none",
    });
    layerCohabiting.appendChild(cohabitingPath);

    // 見た目の枠線(上のcohabitingPath)は他の図形より背面に描くが、
    // 移動操作の対象（同じ形の縁＝cohabitingPathHit）は常に最前面に置く。
    // そうしないと、上に乗った関係線や図形にクリックを奪われてつかめない。
    cohabitingPathHit = svgEl("path", {
      class: "cohabiting-boundary-hit",
      fill: "none",
      stroke: "transparent",
      "stroke-width": "20",
      visibility: "hidden",
    });
    layerInteraction.appendChild(cohabitingPathHit);
    setupCohabitingBoundaryInteraction();

    // 同居枠の輪郭を変形する操作用の丸（最前面）。枠線本体より後にappendして、
    // 同じ場所をクリックした時に丸の方が優先して反応するようにする。
    // グループ枠の操作用の丸は、グループごとにaddGroupBoundary内で個別に作る
    // （重なった時に「つかんだ枠だけ最前面に出す」操作をしやすくするため）。
    cohabitingHandlesGroup = svgEl("g", { class: "cohabiting-handles" });
    layerInteraction.appendChild(cohabitingHandlesGroup);

    doc.persons.forEach(addPersonNode);
    doc.institutions.forEach(addInstitutionNode);
    (doc.groups || []).forEach(addGroupBoundary);
    // 関係線・つなぐ線(institutionLinks)を描く前に同居枠の重心を計算しておくことで、
    // 「世帯全体」への接続線もgetNodeCenter経由で解決できるようにする。
    updateCohabitingBoundary();

    const familyGroups = Genogram.relationRules.buildFamilyTreeGroups(doc);
    const handledRelIds = new Set();
    familyGroups.forEach((group) => {
      Object.values(group.childRelIds).forEach((ids) => ids.forEach((id) => handledRelIds.add(id)));
    });
    doc.relationships.forEach((relationship) => {
      if (handledRelIds.has(relationship.id)) return;
      addRelationshipLine(relationship);
    });
    familyGroups.forEach((group) => addFamilyTreeConnector(group));

    doc.institutionLinks.forEach(addInstitutionLink);
  }

  function makeDraggable(group, getPos, setPos, onMoved, onClick) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;
    let moved = false;

    group.addEventListener("pointerdown", (evt) => {
      dragging = true;
      moved = false;
      group.setPointerCapture(evt.pointerId);
      evt.stopPropagation();
      const world = screenToWorld(evt.clientX, evt.clientY);
      startX = world.x;
      startY = world.y;
      const pos = getPos();
      originX = pos.x;
      originY = pos.y;
      evt.preventDefault();
    });

    group.addEventListener("pointermove", (evt) => {
      if (!dragging) return;
      const world = screenToWorld(evt.clientX, evt.clientY);
      const curX = world.x;
      const curY = world.y;
      if (Math.hypot(curX - startX, curY - startY) > CLICK_MOVE_THRESHOLD) moved = true;
      const newX = originX + (curX - startX);
      const newY = originY + (curY - startY);
      setPos(newX, newY);
      group.setAttribute("transform", `translate(${newX}, ${newY})`);
      onMoved();
    });

    group.addEventListener("pointerup", (evt) => {
      dragging = false;
      group.releasePointerCapture(evt.pointerId);
      if (!moved && onClick) onClick(evt.clientX, evt.clientY);
      // ドラッグで位置を変えただけ（他の操作をしていない）でも保存されるようにする
      if (moved && onDragEnd) onDragEnd();
    });
  }

  function addPersonNode(person) {
    const group = svgEl("g", {
      class: "person-node",
      transform: `translate(${person.x}, ${person.y})`,
    });
    group.style.cursor = "grab";

    const color = GENDER_COLOR[person.gender] || GENDER_COLOR[Genogram.Gender.UNKNOWN];
    const fill = person.isCohabiting ? "#d6ecff" : "#f8fbfe";
    const half = NODE_SIZE / 2;
    const isSubject = currentDocument && person.id === currentDocument.subjectId;

    function makeShape(radius) {
      if (person.gender === Genogram.Gender.MALE) {
        return svgEl("rect", {
          x: -radius, y: -radius, width: radius * 2, height: radius * 2, rx: 8,
        });
      }
      if (person.gender === Genogram.Gender.FEMALE) {
        return svgEl("circle", { cx: 0, cy: 0, r: radius });
      }
      return svgEl("polygon", {
        points: `0,${-radius} ${radius},0 0,${radius} ${-radius},0`,
      });
    }

    // 本人（基準者）は標準のジェノグラム記法に合わせて二重線で示す
    if (isSubject) {
      const outline = makeShape(half + 6);
      outline.setAttribute("fill", "none");
      outline.setAttribute("stroke", color);
      outline.setAttribute("stroke-width", "2");
      group.appendChild(outline);
    }

    const shape = makeShape(half);
    shape.setAttribute("fill", fill);
    shape.setAttribute("stroke", color);
    shape.setAttribute("stroke-width", "3");
    group.appendChild(shape);

    if (person.age !== null && person.age !== undefined && person.age !== "") {
      const ageText = svgEl("text", {
        x: 0, y: 5, "text-anchor": "middle", "font-size": scaledFontSize(16),
        fill: "#2f3b52", "font-weight": "bold",
      });
      ageText.textContent = person.age;
      group.appendChild(ageText);
    }

    // 死亡：標準のジェノグラム記法に合わせて、図形に重ねて×印を引く
    if (person.isDeceased) {
      const corner = half + 4;
      [
        [-corner, -corner, corner, corner],
        [corner, -corner, -corner, corner],
      ].forEach(([x1, y1, x2, y2]) => {
        group.appendChild(
          svgEl("line", { x1, y1, x2, y2, class: "deceased-mark", stroke: "#2f3b52", "stroke-width": "3" })
        );
      });
    }

    const label = svgEl("text", {
      x: 0,
      y: LABEL_OFFSET,
      "text-anchor": "middle",
      "font-size": scaledFontSize(13),
      fill: "#2f3b52",
      "font-weight": "bold",
    });
    label.textContent = person.name;
    group.appendChild(label);

    // キーパーソン（主たる介護者・連絡先）の明示：名前の下に専用ラベルを出す
    if (person.isKeyPerson) {
      const keyLabel = svgEl("text", {
        x: 0,
        y: LABEL_OFFSET + 16,
        "text-anchor": "middle",
        "font-size": scaledFontSize(11),
        "font-weight": "bold",
        class: "key-person-label",
        fill: "#c2790a",
      });
      keyLabel.textContent = "★ キーパーソン";
      group.appendChild(keyLabel);
    }

    if (person.note) {
      const noteStartY = LABEL_OFFSET + 16 + (person.isKeyPerson ? 16 : 0);
      const noteText = svgEl("text", {
        x: 0, y: 0, "text-anchor": "middle", "font-size": scaledFontSize(11), fill: "#6b7c93",
      });
      const noteLines = wrapTextByLength(person.note, 12);
      noteLines.forEach((line, index) => {
        const tspan = svgEl("tspan", { x: 0, y: noteStartY + index * 14 });
        tspan.textContent = line;
        noteText.appendChild(tspan);
      });
      group.appendChild(noteText);
    }

    layerNodes.appendChild(group);
    personGroups[person.id] = group;

    makeDraggable(
      group,
      () => ({ x: person.x, y: person.y }),
      (x, y) => {
        person.x = x;
        person.y = y;
        person.manuallyMoved = true;
      },
      () => {
        updateLinesForNode(person.id);
        updateCohabitingBoundary();
        updateGroupBoundaries();
      },
      (clientX, clientY) => {
        if (onPersonClick) onPersonClick(person, clientX, clientY);
      }
    );

    return group;
  }

  function addInstitutionNode(institution) {
    const group = svgEl("g", {
      class: "institution-node",
      transform: `translate(${institution.x}, ${institution.y})`,
    });
    group.style.cursor = "grab";

    const rect = svgEl("rect", {
      x: -INSTITUTION_W / 2,
      y: -INSTITUTION_H / 2,
      width: INSTITUTION_W,
      height: INSTITUTION_H,
      rx: 12,
      fill: "#e3f2fd",
      stroke: "#4ecdc4",
      "stroke-width": "3",
    });
    group.appendChild(rect);

    // <foreignObject>(HTML埋め込み)はPNG書き出し時にcanvasが「tainted」と
    // 判定されて失敗するため使わず、<text>+<tspan>で折り返し表示する
    const label = svgEl("text", {
      x: 0, y: 0, "text-anchor": "middle", "font-size": scaledFontSize(12),
      "font-weight": "bold", fill: "#2b5b6e",
    });
    const lines = wrapTextByLength(institution.name, 9);
    const lineHeight = 15;
    const startY = -((lines.length - 1) * lineHeight) / 2 + 4;
    lines.forEach((line, index) => {
      const tspan = svgEl("tspan", { x: 0, y: startY + index * lineHeight });
      tspan.textContent = line;
      label.appendChild(tspan);
    });
    group.appendChild(label);

    if (institution.note) {
      const noteLabel = svgEl("text", {
        x: 0, y: INSTITUTION_H / 2 + 16, "text-anchor": "middle", "font-size": scaledFontSize(11), fill: "#6b7c93",
      });
      const noteLines = wrapTextByLength(institution.note, 14);
      noteLines.forEach((line, index) => {
        const tspan = svgEl("tspan", { x: 0, y: INSTITUTION_H / 2 + 16 + index * 14 });
        tspan.textContent = line;
        noteLabel.appendChild(tspan);
      });
      group.appendChild(noteLabel);
    }

    layerNodes.appendChild(group);
    institutionGroups[institution.id] = group;

    makeDraggable(
      group,
      () => ({ x: institution.x, y: institution.y }),
      (x, y) => {
        institution.x = x;
        institution.y = y;
        institution.manuallyMoved = true;
      },
      () => {
        updateLinesForNode(institution.id);
        updateGroupBoundaries();
      },
      (clientX, clientY) => {
        if (onInstitutionClick) onInstitutionClick(institution, clientX, clientY);
      }
    );

    return group;
  }

  function wrapTextByLength(text, maxCharsPerLine) {
    const lines = [];
    for (let i = 0; i < text.length; i += maxCharsPerLine) {
      lines.push(text.slice(i, i + maxCharsPerLine));
    }
    return lines.length > 0 ? lines : [""];
  }

  function getNodeCenter(nodeId) {
    const group = personGroups[nodeId] || institutionGroups[nodeId];
    if (group) {
      const transform = group.getAttribute("transform") || "translate(0,0)";
      const match = /translate\(([-\d.]+),\s*([-\d.]+)\)/.exec(transform);
      if (!match) return { x: 0, y: 0 };
      return { x: parseFloat(match[1]), y: parseFloat(match[2]) };
    }
    return groupCenters[nodeId] || null;
  }

  // 線分(a→b)と線分(c→d)の交点を求める（どちらの線分の範囲内にも収まる場合のみ）
  function segmentIntersection(a, b, c, d) {
    const d1x = b.x - a.x, d1y = b.y - a.y;
    const d2x = d.x - c.x, d2y = d.y - c.y;
    const denom = d1x * d2y - d1y * d2x;
    if (Math.abs(denom) < 1e-9) return null;
    const t = ((c.x - a.x) * d2y - (c.y - a.y) * d2x) / denom;
    const u = ((c.x - a.x) * d1y - (c.y - a.y) * d1x) / denom;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { x: a.x + t * d1x, y: a.y + t * d1y };
  }

  // グループ・同居枠は重心を当たり判定にすると、線が枠線の内側まで入り込んで
  // 見た目が崩れる（枠は半透明で背面にあるため、線が枠を突き破って見える）。
  // 「相手の位置→重心」の線分が枠の凸包と交わる点を探し、見つかればそこを
  // 接続点として使うことで、線が枠線の縁で自然に止まるようにする。
  function clipPointToHull(outsidePoint, insidePoint, hull) {
    if (!hull || hull.length < 3) return insidePoint;
    for (let i = 0; i < hull.length; i++) {
      const hit = segmentIntersection(outsidePoint, insidePoint, hull[i], hull[(i + 1) % hull.length]);
      if (hit) return hit;
    }
    return insidePoint;
  }

  // 関係線の片端がグループ/同居枠の場合、相手側の位置を見て枠の縁に接続点を補正する。
  // 通常の人物・関係機関ならそのまま中心点を返す。
  function resolveLineEndpoint(nodeId, ownCenter, otherCenter) {
    const hull = groupHulls[nodeId];
    if (!hull) return ownCenter;
    return clipPointToHull(otherCenter, ownCenter, hull);
  }

  function zigzagPoints(p1, p2) {
    const segments = 8;
    const dx = (p2.x - p1.x) / segments;
    const dy = (p2.y - p1.y) / segments;
    const length = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
    const nx = (-(p2.y - p1.y) / length) * 6;
    const ny = ((p2.x - p1.x) / length) * 6;

    const points = [p1];
    for (let i = 1; i < segments; i++) {
      const baseX = p1.x + dx * i;
      const baseY = p1.y + dy * i;
      const sign = i % 2 === 1 ? 1 : -1;
      points.push({ x: baseX + nx * sign, y: baseY + ny * sign });
    }
    points.push(p2);
    return points;
  }

  // 図形の中心から見て、指定した向き(dx,dy)に伸ばした直線が図形の輪郭にぶつかるまでの
  // 距離を返す。四角(男性)・ひし形(不明)は斜め方向だと角が中心から遠くなり、
  // 円(女性)を基準にした固定の引き戻し量では収まりきらず矢印が図形の中に埋もれてしまう
  // ため、実際の図形の形に合わせて距離を計算する。本人は二重線の分だけ一回り大きい。
  function nodeShapeHalfExtents(nodeId) {
    if (currentDocument) {
      const person = currentDocument.persons.find((p) => p.id === nodeId);
      if (person) {
        const isSubject = person.id === currentDocument.subjectId;
        const half = NODE_SIZE / 2 + (isSubject ? 6 : 0);
        return { shape: person.gender, halfW: half, halfH: half };
      }
      const institution = currentDocument.institutions.find((i) => i.id === nodeId);
      if (institution) {
        return { shape: "rect", halfW: INSTITUTION_W / 2, halfH: INSTITUTION_H / 2 };
      }
    }
    return null;
  }

  function shapeEdgeDistance(nodeId, dx, dy) {
    const extents = nodeShapeHalfExtents(nodeId);
    if (!extents) return NODE_SIZE / 2; // 人物・関係機関以外（フォールバック）
    const length = Math.hypot(dx, dy) || 1;
    const ux = Math.abs(dx / length) || 1e-6;
    const uy = Math.abs(dy / length) || 1e-6;
    if (extents.shape === Genogram.Gender.FEMALE) return extents.halfW; // 円は向きによらず一定
    if (extents.shape === Genogram.Gender.MALE || extents.shape === "rect") {
      // 四角・長方形：軸に沿った境界までの距離のうち、先に当たる方
      return Math.min(extents.halfW / ux, extents.halfH / uy);
    }
    // 不明＝ひし形：|x|/halfW + |y|/halfH = 1 の輪郭までの距離
    return 1 / (ux / extents.halfW + uy / extents.halfH);
  }

  // 「働きかけ」関係(矢印)の矢印先端が、人物・関係機関の図形そのものの内側に
  // 隠れて見えなくなってしまうのを防ぐため、矢印が向かう側の終点を図形の手前で止める。
  // すでに枠線(グループ・同居の枠)の縁に合わせてある点(groupHulls管理下)は、
  // それ以上ずらすと縁から浮いてしまうのでそのままにする。
  function arrowAdjustedEndpoint(nodeId, point, fromPoint, type) {
    if (type !== Genogram.RelationType.WORKING && type !== Genogram.RelationType.WORKING_BOTH) return point;
    if (groupHulls[nodeId]) return point;
    const dx = point.x - fromPoint.x;
    const dy = point.y - fromPoint.y;
    const length = Math.hypot(dx, dy) || 1;
    const pullback = shapeEdgeDistance(nodeId, dx, dy) + 4;
    const ratio = Math.max(0, (length - pullback) / length);
    return { x: fromPoint.x + dx * ratio, y: fromPoint.y + dy * ratio };
  }

  function drawRelationLine(group, p1, p2, type, maritalStatus) {
    while (group.firstChild) group.removeChild(group.firstChild);

    const stroke = "#4a5a72";
    const visible = svgEl("g");

    if (type === Genogram.RelationType.CONFLICT) {
      // ストレスのある関係：実線＋垂直の刻み線（||||）標準エコマップ記法
      visible.appendChild(svgEl("line", { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, stroke, "stroke-width": 2 }));
      const totalLen = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
      const dirX = (p2.x - p1.x) / totalLen;
      const dirY = (p2.y - p1.y) / totalLen;
      const perpX = -dirY;
      const perpY = dirX;
      const ticks = 7;
      const tickHalf = 7;
      for (let i = 1; i <= ticks; i++) {
        const t = i / (ticks + 1);
        const cx = p1.x + (p2.x - p1.x) * t;
        const cy = p1.y + (p2.y - p1.y) * t;
        visible.appendChild(svgEl("line", {
          x1: cx - perpX * tickHalf, y1: cy - perpY * tickHalf,
          x2: cx + perpX * tickHalf, y2: cy + perpY * tickHalf,
          stroke, "stroke-width": 2,
        }));
      }
    } else if (type === Genogram.RelationType.STRONG) {
      // 強い関係：太い1本線（標準エコマップ記法）
      visible.appendChild(svgEl("line", { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, stroke, "stroke-width": 4.5 }));
    } else {
      const line = svgEl("line", { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, stroke, "stroke-width": 2 });
      if (type === Genogram.RelationType.WEAK) {
        line.setAttribute("stroke-dasharray", "5,4");
      }
      visible.appendChild(line);
    }

    // 別居・離婚：標準のジェノグラム記法に合わせて、結婚線の中央に斜線を入れる
    // （別居=1本、離婚=2本）
    if (maritalStatus === "separated" || maritalStatus === "divorced") {
      const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
      const markHalfLength = 9;
      const markDx = Math.cos(angle + Math.PI / 4) * markHalfLength;
      const markDy = Math.sin(angle + Math.PI / 4) * markHalfLength;
      const ux = Math.cos(angle);
      const uy = Math.sin(angle);
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      const offsets = maritalStatus === "divorced" ? [-4, 4] : [0];
      offsets.forEach((offset) => {
        const cx = midX + ux * offset;
        const cy = midY + uy * offset;
        visible.appendChild(
          svgEl("line", {
            x1: cx - markDx, y1: cy - markDy, x2: cx + markDx, y2: cy + markDy,
            class: "marital-status-mark", stroke, "stroke-width": 2,
          })
        );
      });
    }

    if (type === Genogram.RelationType.WORKING || type === Genogram.RelationType.WORKING_BOTH) {
      // p2側の矢印
      const angle2 = Math.atan2(p2.y - p1.y, p2.x - p1.x);
      visible.appendChild(svgEl("polygon", {
        points: [
          `${p2.x},${p2.y}`,
          `${p2.x - ARROW_SIZE * Math.cos(angle2 - Math.PI / 6)},${p2.y - ARROW_SIZE * Math.sin(angle2 - Math.PI / 6)}`,
          `${p2.x - ARROW_SIZE * Math.cos(angle2 + Math.PI / 6)},${p2.y - ARROW_SIZE * Math.sin(angle2 + Math.PI / 6)}`,
        ].join(" "),
        fill: stroke,
      }));
    }
    if (type === Genogram.RelationType.WORKING_BOTH) {
      // p1側にも矢印（双方向）
      const angle1 = Math.atan2(p1.y - p2.y, p1.x - p2.x);
      visible.appendChild(svgEl("polygon", {
        points: [
          `${p1.x},${p1.y}`,
          `${p1.x - ARROW_SIZE * Math.cos(angle1 - Math.PI / 6)},${p1.y - ARROW_SIZE * Math.sin(angle1 - Math.PI / 6)}`,
          `${p1.x - ARROW_SIZE * Math.cos(angle1 + Math.PI / 6)},${p1.y - ARROW_SIZE * Math.sin(angle1 + Math.PI / 6)}`,
        ].join(" "),
        fill: stroke,
      }));
    }

    // クリック・右クリック判定用の太い透明な線（見た目には影響しない）
    const hitArea = svgEl("line", {
      x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
      stroke: "transparent", "stroke-width": 16,
    });
    hitArea.style.cursor = "context-menu";

    group.appendChild(visible);
    group.appendChild(hitArea);
    return hitArea;
  }

  // 関係性メニューは左クリックでも開けるようにする（右クリックは発見されにくいため）。
  // 右クリックも互換のため残す（ブラウザ標準の右クリックメニューが出ないよう常にpreventDefault）。
  function attachContextMenu(hitArea, linkRef) {
    function openMenu(evt) {
      evt.preventDefault();
      evt.stopPropagation(); // 左クリックの場合、documentへのclickバブリングでメニューが即閉じてしまうのを防ぐ
      if (onLineContextMenu) onLineContextMenu(linkRef, evt.clientX, evt.clientY);
    }
    hitArea.addEventListener("click", openMenu);
    hitArea.addEventListener("contextmenu", openMenu);
  }

  function addRelationshipLine(relationship) {
    let p1 = getNodeCenter(relationship.personAId);
    let p2 = getNodeCenter(relationship.personBId);
    if (!p1 || !p2) return null;
    if (relationship.type === Genogram.RelationType.WORKING_BOTH) {
      p1 = arrowAdjustedEndpoint(relationship.personAId, p1, p2, relationship.type);
    }
    p2 = arrowAdjustedEndpoint(relationship.personBId, p2, p1, relationship.type);

    const group = svgEl("g", { class: "relationship-line", "data-id": relationship.id });
    const hitArea = drawRelationLine(group, p1, p2, relationship.type, relationship.maritalStatus);
    attachContextMenu(hitArea, relationship);
    layerLines.appendChild(group);

    relationshipLines[relationship.id] = {
      group, link: relationship, aId: relationship.personAId, bId: relationship.personBId,
    };
    return group;
  }

  function addInstitutionLink(link) {
    const c1 = getNodeCenter(link.fromId);
    const c2 = getNodeCenter(link.toId);
    if (!c1 || !c2) return null;
    let p1 = resolveLineEndpoint(link.fromId, c1, c2);
    const p2 = arrowAdjustedEndpoint(link.toId, resolveLineEndpoint(link.toId, c2, c1), p1, link.type);
    if (link.type === Genogram.RelationType.WORKING_BOTH) {
      p1 = arrowAdjustedEndpoint(link.fromId, p1, p2, link.type);
    }

    const group = svgEl("g", { class: "institution-link-line", "data-id": link.id });
    const hitArea = drawRelationLine(group, p1, p2, link.type, link.maritalStatus);
    attachContextMenu(hitArea, link);
    layerLines.appendChild(group);

    institutionLinkLines[link.id] = {
      group, link, aId: link.fromId, bId: link.toId,
    };
    return group;
  }

  function updateLinesForNode(nodeId) {
    [relationshipLines, institutionLinkLines].forEach((store) => {
      Object.values(store).forEach((entry) => {
        if (entry.aId === nodeId || entry.bId === nodeId) {
          const c1 = getNodeCenter(entry.aId);
          const c2 = getNodeCenter(entry.bId);
          if (c1 && c2) {
            let p1 = resolveLineEndpoint(entry.aId, c1, c2);
            const p2 = arrowAdjustedEndpoint(entry.bId, resolveLineEndpoint(entry.bId, c2, c1), p1, entry.link.type);
            if (entry.link.type === Genogram.RelationType.WORKING_BOTH) {
              p1 = arrowAdjustedEndpoint(entry.aId, p1, p2, entry.link.type);
            }
            const hitArea = drawRelationLine(entry.group, p1, p2, entry.link.type, entry.link.maritalStatus);
            attachContextMenu(hitArea, entry.link);
          }
        }
      });
    });
    familyTreeConnectors.forEach((entry) => {
      if (entry.group.parentIds.includes(nodeId) || entry.group.childIds.includes(nodeId)) {
        drawFamilyConnectorInto(entry.element, entry.group);
      }
    });
  }

  // ===== ジェノグラム標準の樹形図コネクタ（結婚線の中点→兄弟バー→各子への枝）=====

  function drawFamilyConnectorInto(element, group) {
    while (element.firstChild) element.removeChild(element.firstChild);

    const parentCenters = group.parentIds.map(getNodeCenter).filter(Boolean);
    const childCenters = group.childIds
      .map((id) => ({ id, center: getNodeCenter(id) }))
      .filter((c) => c.center);
    if (parentCenters.length === 0 || childCenters.length === 0) return;

    const stroke = "#4a5a72";
    const dropX = parentCenters.length === 2
      ? (parentCenters[0].x + parentCenters[1].x) / 2
      : parentCenters[0].x;
    const dropY = parentCenters[0].y;
    const childY = childCenters[0].center.y;
    const barY = (dropY + childY) / 2;

    element.appendChild(svgEl("line", { x1: dropX, y1: dropY, x2: dropX, y2: barY, stroke, "stroke-width": 2 }));

    if (childCenters.length === 1) {
      const only = childCenters[0];
      element.appendChild(
        svgEl("line", { x1: dropX, y1: barY, x2: only.center.x, y2: barY, stroke, "stroke-width": 2 })
      );
      appendChildStem(element, group, only, barY, stroke);
    } else {
      const xs = childCenters.map((c) => c.center.x).concat(dropX);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      element.appendChild(svgEl("line", { x1: minX, y1: barY, x2: maxX, y2: barY, stroke, "stroke-width": 2 }));
      childCenters.forEach((c) => appendChildStem(element, group, c, barY, stroke));
    }
  }

  function appendChildStem(element, group, childEntry, barY, stroke) {
    element.appendChild(
      svgEl("line", {
        x1: childEntry.center.x, y1: barY, x2: childEntry.center.x, y2: childEntry.center.y,
        stroke, "stroke-width": 2,
      })
    );
    const hitArea = svgEl("line", {
      x1: childEntry.center.x, y1: barY, x2: childEntry.center.x, y2: childEntry.center.y,
      stroke: "transparent", "stroke-width": 16,
    });
    hitArea.style.cursor = "context-menu";
    hitArea.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      if (onLineContextMenu) {
        onLineContextMenu(
          { __familyStem: true, relIds: group.childRelIds[childEntry.id] },
          evt.clientX,
          evt.clientY
        );
      }
    });
    element.appendChild(hitArea);
  }

  function addFamilyTreeConnector(group) {
    const element = svgEl("g", { class: "family-tree-connector" });
    layerLines.appendChild(element);
    drawFamilyConnectorInto(element, group);
    familyTreeConnectors.push({ element, group });
    return element;
  }

  function redrawLineType(linkRef) {
    const entry = relationshipLines[linkRef.id] || institutionLinkLines[linkRef.id];
    if (!entry) return;
    const c1 = getNodeCenter(entry.aId);
    const c2 = getNodeCenter(entry.bId);
    let p1 = resolveLineEndpoint(entry.aId, c1, c2);
    const p2 = arrowAdjustedEndpoint(entry.bId, resolveLineEndpoint(entry.bId, c2, c1), p1, entry.link.type);
    if (entry.link.type === Genogram.RelationType.WORKING_BOTH) {
      p1 = arrowAdjustedEndpoint(entry.aId, p1, p2, entry.link.type);
    }
    const hitArea = drawRelationLine(entry.group, p1, p2, entry.link.type, entry.link.maritalStatus);
    attachContextMenu(hitArea, entry.link);
  }

  // 対象者だけを正確に囲む、滑らかな閉曲線（ブロブ）の境界を作る。
  // 矩形のbounding boxだと対象外の人がたまたま範囲内に入ってしまうことがあるため、
  // 各対象者の周囲に置いた点の凸包(convex hull)を使い、形状そのものを対象者にぴったり沿わせる。

  function convexHull(points) {
    if (points.length < 3) return points;
    const pts = points.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper);
  }

  // 各メンバーの中心点の周りに8点をばらまいてから凸包を取ると、
  // 結果的に「各メンバーから一定の余白(padding)だけ外側に膨らんだ」hullになる。
  // 備考（メモ）が表示されているメンバーは、下方向の点だけその分余白を広げる
  // （center.extraBottomに、備考の表示行数に応じた高さを渡してもらう）ことで、
  // 枠線の輪郭が備考の文字に重ならないようにする。
  // extraPadding：同居枠とグループ枠のメンバーが完全に同じ場合でも、形・操作用の丸の
  // 位置が完全に重なって奥の丸が一切つかめなくなることを防ぐため、グループ枠側だけ
  // 少し広めの余白で描く（常に一定の隙間ができ、どちらの丸も必ずつかめるようにする）。
  function computeBoundaryHull(centers, extraPadding) {
    const PADDING = 36 + (extraPadding || 0);
    const baseRadius = NODE_SIZE / 2 + PADDING;
    const expandedPoints = [];
    centers.forEach((center) => {
      const bottomRadius = baseRadius + (center.extraBottom || 0);
      for (let i = 0; i < 10; i++) {
        const angle = (i / 10) * Math.PI * 2;
        const radius = Math.sin(angle) > 0.3 ? bottomRadius : baseRadius;
        expandedPoints.push({
          x: center.x + radius * Math.cos(angle),
          y: center.y + radius * Math.sin(angle),
        });
      }
    });
    return convexHull(expandedPoints);
  }

  // 備考（メモ）の表示行数から、枠線の下方向にどれだけ余白を追加すべきかを求める
  // （person-nodeの備考表示ロジック：開始位置LABEL_OFFSET+16(+16キーパーソン時)、行高14と揃える）
  function noteExtraBottomPadding(id) {
    const person = (currentDocument.persons || []).find((p) => p.id === id);
    if (person && person.note) {
      const lineCount = wrapTextByLength(person.note, 12).length;
      return 16 + (person.isKeyPerson ? 16 : 0) + lineCount * 14;
    }
    const institution = (currentDocument.institutions || []).find((i) => i.id === id);
    if (institution && institution.note) {
      const lineCount = wrapTextByLength(institution.note, 14).length;
      return 16 + lineCount * 14;
    }
    return 0;
  }

  // 重心からangle方向に伸ばした光線が、自動計算した凸包(hull)のどこを通るかを
  // 求める。「自動計算した時のその方向の半径」として、12方向の基準点を作るのに使う。
  function baseRadiusAtAngle(centroid, angle, hull) {
    const far = { x: centroid.x + Math.cos(angle) * 100000, y: centroid.y + Math.sin(angle) * 100000 };
    for (let i = 0; i < hull.length; i++) {
      const hit = segmentIntersection(centroid, far, hull[i], hull[(i + 1) % hull.length]);
      if (hit) return Math.hypot(hit.x - centroid.x, hit.y - centroid.y);
    }
    return NODE_SIZE / 2 + 36;
  }

  // 重心からの距離が極端に近づいたり離れたりすると、線が自分自身と交差して
  // 形が破綻してしまうことがあるため、安全な範囲にクランプする。
  function clampDistanceFromCentroid(centroid, x, y) {
    const dist = Math.hypot(x - centroid.x, y - centroid.y);
    if (dist < SHAPE_MIN_RADIUS) {
      const scale = SHAPE_MIN_RADIUS / Math.max(dist, 0.001);
      return { x: centroid.x + (x - centroid.x) * scale, y: centroid.y + (y - centroid.y) * scale };
    }
    if (dist > SHAPE_MAX_RADIUS) {
      const scale = SHAPE_MAX_RADIUS / dist;
      return { x: centroid.x + (x - centroid.x) * scale, y: centroid.y + (y - centroid.y) * scale };
    }
    return { x, y };
  }

  // 自動計算した形(hull)に、保存されている手動調整(shapeOffsets：12方向それぞれの
  // 基準点からの{dx,dy}のズレ)を重ねた、実際に描画する12点を求める。
  // 縦・横・斜めどの方向にもズラせるよう、半径(1次元)ではなくxy座標のズレ(2次元)で持つ。
  function computeShapePoints(hull, centroid, shapeOffsets) {
    const points = [];
    for (let i = 0; i < SHAPE_ANGLE_STEPS; i++) {
      const angle = (i / SHAPE_ANGLE_STEPS) * Math.PI * 2;
      const baseRadius = baseRadiusAtAngle(centroid, angle, hull);
      const baseX = centroid.x + Math.cos(angle) * baseRadius;
      const baseY = centroid.y + Math.sin(angle) * baseRadius;
      const offset = (shapeOffsets && shapeOffsets[i]) || { dx: 0, dy: 0 };
      const clamped = clampDistanceFromCentroid(centroid, baseX + (offset.dx || 0), baseY + (offset.dy || 0));
      points.push({ x: clamped.x, y: clamped.y, baseX, baseY });
    }
    return points;
  }

  // 枠線の輪郭上に、ドラッグして変形できる小さな丸を描く。つまんで縦・横・斜め、
  // どの方向にでも自由に動かせる（中心方向だけでなく、その点を自由な位置に
  // 動かせるようにすることで、無関係な人の図形を縦横どちらからでも避けられる）。
  // ダブルクリックすると、その点だけ自動計算の位置に戻る。
  // color: 同居枠／グループ枠を見分けやすくするための色（重なった時の視認性向け）。
  // bringToFront: つかんだ枠の丸を最前面に持ってきて、重なっている時に操作しやすくする。
  function appendShapeHandles(container, centroid, points, getShapeOffsets, rerender, color, bringToFront) {
    points.forEach((point, index) => {
      const handle = svgEl("circle", {
        cx: point.x,
        cy: point.y,
        r: 6,
        class: "boundary-shape-handle",
        fill: color,
        stroke: "#ffffff",
        "stroke-width": "1.5",
      });
      handle.style.cursor = "grab";
      handle.addEventListener("pointerdown", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        if (bringToFront) bringToFront();
        const baseX = point.baseX;
        const baseY = point.baseY;
        function onMove(moveEvt) {
          const world = screenToWorld(moveEvt.clientX, moveEvt.clientY);
          const offsets = getShapeOffsets();
          offsets[index] = { dx: world.x - baseX, dy: world.y - baseY };
          rerender();
        }
        function onUp() {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        }
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      });
      handle.addEventListener("dblclick", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const offsets = getShapeOffsets();
        offsets[index] = { dx: 0, dy: 0 };
        rerender();
      });
      container.appendChild(handle);
    });
  }

  // hullの頂点をそのまま直線で結ぶと角張ってしまうので、閉じたCatmull-Romスプライン
  // （各頂点を実際に通る滑らかな曲線）でつないだ「ぐにゃぐにゃ」した自然な輪郭にする。
  // 以前は頂点を曲線の制御点としてだけ使い、曲線自体は頂点の手前で折り返す方式
  // だったため、変形用の丸（頂点ちょうどの位置に表示）が線からズレて見えて
  // 違和感があった。各頂点を確実に線が通るこの方式に変えることで、丸を線の上に
  // 重ねて表示できるようにした。
  function hullToSmoothPath(hull) {
    const n = hull.length;
    if (n < 3) return "";
    let d = "";
    for (let i = 0; i < n; i++) {
      const p0 = hull[(i - 1 + n) % n];
      const p1 = hull[i];
      const p2 = hull[(i + 1) % n];
      const p3 = hull[(i + 2) % n];
      const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
      const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
      if (i === 0) d += `M ${p1.x} ${p1.y} `;
      d += `C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y} `;
    }
    return d + "Z";
  }

  function updateCohabitingBoundary() {
    if (!currentDocument) return;
    const cohabitingIds = currentDocument.persons.filter((p) => p.isCohabiting).map((p) => p.id);
    // 「同居している」は他の家族から見た「本人と一緒に住んでいる」という意味なので、
    // 誰か一人でもチェックされていれば本人も同じ世帯に含める（本人自身にチェックは不要）
    if (cohabitingIds.length > 0 && currentDocument.subjectId && !cohabitingIds.includes(currentDocument.subjectId)) {
      cohabitingIds.push(currentDocument.subjectId);
    }

    const centerEntries = cohabitingIds
      .map((id) => ({ id, center: getNodeCenter(id) }))
      .filter((entry) => entry.center);
    if (centerEntries.length === 0) {
      cohabitingPath.setAttribute("visibility", "hidden");
      cohabitingPathHit.setAttribute("visibility", "hidden");
      cohabitingHandlesGroup.innerHTML = "";
      delete groupCenters[COHABITING_BOUNDARY_ID];
      delete groupHulls[COHABITING_BOUNDARY_ID];
      updateLinesForNode(COHABITING_BOUNDARY_ID);
      return;
    }

    const offset = currentDocument.cohabitingBoundaryOverride || { dx: 0, dy: 0 };
    const shiftedCenters = centerEntries.map(({ id, center }) => ({
      x: center.x + offset.dx,
      y: center.y + offset.dy,
      extraBottom: noteExtraBottomPadding(id),
    }));
    const hull = computeBoundaryHull(shiftedCenters);
    const centroid = {
      x: shiftedCenters.reduce((sum, c) => sum + c.x, 0) / shiftedCenters.length,
      y: shiftedCenters.reduce((sum, c) => sum + c.y, 0) / shiftedCenters.length,
    };
    if (!currentDocument.cohabitingBoundaryShape) currentDocument.cohabitingBoundaryShape = [];
    const shapePoints = computeShapePoints(hull, centroid, currentDocument.cohabitingBoundaryShape);
    const d = hullToSmoothPath(shapePoints);
    groupHulls[COHABITING_BOUNDARY_ID] = shapePoints;

    cohabitingPath.setAttribute("visibility", "visible");
    cohabitingPathHit.setAttribute("visibility", "visible");
    cohabitingPath.setAttribute("d", d);
    cohabitingPathHit.setAttribute("d", d);

    cohabitingHandlesGroup.innerHTML = "";
    appendShapeHandles(
      cohabitingHandlesGroup,
      centroid,
      shapePoints,
      () => currentDocument.cohabitingBoundaryShape,
      updateCohabitingBoundary,
      "#7a8aa0",
      () => layerInteraction.appendChild(cohabitingHandlesGroup)
    );

    // 「世帯全体」への関係線をgetNodeCenter経由で解決できるよう、重心を記録する
    groupCenters[COHABITING_BOUNDARY_ID] = centroid;
    updateLinesForNode(COHABITING_BOUNDARY_ID);
  }

  // ===== エコマップの任意グループ（拡大家族・職場など）の枠線 =====
  // 同居枠と同じ凸包(computeBoundaryHull/hullToSmoothPath)の仕組みを使って、
  // ユーザーが選んだメンバー（人物・関係機関どちらでも）を囲む枠線を描く。
  // 枠線自体はinstitutionLinkのfromId/toIdに指定できるよう、重心をgroupCentersに
  // 記録しておく（getNodeCenterがここを見て関係線の接続先として解決する）。
  function addGroupBoundary(group) {
    const centers = (group.memberIds || [])
      .map((id) => {
        const center = getNodeCenter(id);
        return center ? { ...center, extraBottom: noteExtraBottomPadding(id) } : null;
      })
      .filter(Boolean);
    if (centers.length === 0) return;

    const centroid = {
      x: centers.reduce((sum, c) => sum + c.x, 0) / centers.length,
      y: centers.reduce((sum, c) => sum + c.y, 0) / centers.length,
    };
    groupCenters[group.id] = centroid;

    const hull = computeBoundaryHull(centers, 16);
    if (!group.boundaryShape) group.boundaryShape = [];
    const shapePoints = computeShapePoints(hull, centroid, group.boundaryShape);
    groupHulls[group.id] = shapePoints;
    const path = svgEl("path", {
      class: "ecomap-group-boundary",
      fill: "rgba(255, 200, 120, 0.18)",
      stroke: "#d68a3c",
      "stroke-width": "2",
      "stroke-dasharray": "3,7",
      "stroke-linejoin": "round",
    });
    path.setAttribute("d", hullToSmoothPath(shapePoints));
    path.style.cursor = "pointer";
    path.addEventListener("click", (evt) => {
      evt.stopPropagation();
      if (onGroupClick) onGroupClick(group);
    });
    layerGroups.appendChild(path);

    const topPoint = shapePoints.reduce((top, p) => (p.y < top.y ? p : top), shapePoints[0]);
    const label = svgEl("text", {
      class: "ecomap-group-label",
      x: topPoint.x,
      y: topPoint.y - 10,
      "text-anchor": "middle",
      "font-size": scaledFontSize(13),
      "font-weight": "bold",
      fill: "#b5701f",
    });
    label.textContent = group.label;
    label.style.cursor = "pointer";
    label.addEventListener("click", (evt) => {
      evt.stopPropagation();
      if (onGroupClick) onGroupClick(group);
    });
    layerGroups.appendChild(label);

    // グループごとに操作用の丸をまとめる専用の<g>を作る（同居枠・他グループと
    // 重なって操作しづらい時に、つかんだ枠だけ最前面に出せるようにするため、
    // 全グループ共通の1つの<g>ではなく、グループごとに分けてlayerInteraction
    // 直下に置く）。
    const handlesGroup = svgEl("g", { class: "group-handles" });
    layerInteraction.appendChild(handlesGroup);
    appendShapeHandles(
      handlesGroup,
      centroid,
      shapePoints,
      () => group.boundaryShape,
      updateGroupBoundaries,
      "#d68a3c",
      () => layerInteraction.appendChild(handlesGroup)
    );
  }

  // 人物・関係機関をドラッグした直後に呼ぶ。グループの枠線は重心・凸包を
  // メンバーの位置から都度計算しているだけなので、位置が変わったら枠線を
  // 全部作り直して追従させる（同居枠が`updateCohabitingBoundary`で毎回
  // 再計算しているのと同じ考え方）。
  function updateGroupBoundaries() {
    if (!currentDocument) return;
    layerGroups.innerHTML = "";
    layerInteraction.querySelectorAll(".group-handles").forEach((el) => el.remove());
    const groups = currentDocument.groups || [];
    groups.forEach((g) => {
      delete groupCenters[g.id];
      delete groupHulls[g.id];
    });
    groups.forEach(addGroupBoundary);
    groups.forEach((g) => updateLinesForNode(g.id));
  }

  // ===== 同居枠の手動ドラッグ移動 =====
  // ブロブ形状には「四隅」が無いので、リサイズではなく平行移動だけ手動調整できるようにする。
  // 自動計算した形でも、ここで一度ユーザーが動かすと
  // currentDocument.cohabitingBoundaryOverride（{dx, dy}）に固定され、以後はそちらを使う。
  // 枠の縁（cohabitingPathHit）をダブルクリックすると自動計算（dx:0, dy:0）に戻る。
  // 見た目の輪郭(cohabitingPath)は他の図形より背面に描くため、操作用の当たり判定は
  // 同じ形の別要素(cohabitingPathHit)として最前面のlayerInteractionに置いている。

  function setupCohabitingBoundaryInteraction() {
    cohabitingPathHit.style.cursor = "move";
    cohabitingPathHit.addEventListener("pointerdown", (evt) => startBoundaryDrag(evt));
    cohabitingPathHit.addEventListener("dblclick", () => {
      if (!currentDocument) return;
      currentDocument.cohabitingBoundaryOverride = null;
      updateCohabitingBoundary();
    });
  }

  function startBoundaryDrag(evt) {
    if (!currentDocument) return;
    evt.preventDefault();
    evt.stopPropagation();
    const startWorld = screenToWorld(evt.clientX, evt.clientY);
    const startOffset = currentDocument.cohabitingBoundaryOverride || { dx: 0, dy: 0 };

    function onMove(moveEvt) {
      const world = screenToWorld(moveEvt.clientX, moveEvt.clientY);
      currentDocument.cohabitingBoundaryOverride = {
        dx: startOffset.dx + (world.x - startWorld.x),
        dy: startOffset.dy + (world.y - startWorld.y),
      };
      updateCohabitingBoundary();
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // 文字サイズ倍率を変更して再描画する（現在の位置・パン・ズームには影響しない）
  function setFontScale(scale) {
    fontScale = Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, scale));
    if (currentDocument) renderDocument(currentDocument);
    if (onFontScaleChange) onFontScaleChange(Math.round(fontScale * 100));
  }
  function getFontScale() {
    return fontScale;
  }
  function setFontScaleChangeHandler(handler) {
    onFontScaleChange = handler;
  }

  Genogram.canvas = {
    COHABITING_BOUNDARY_ID,
    setFontScale,
    getFontScale,
    setFontScaleChangeHandler,
    init,
    renderDocument,
    addPersonNode,
    addInstitutionNode,
    addRelationshipLine,
    addInstitutionLink,
    updateCohabitingBoundary,
    setLineContextMenuHandler,
    setPersonClickHandler,
    setInstitutionClickHandler,
    setGroupClickHandler,
    setDragEndHandler,
    setCanvasBackgroundClickHandler,
    setViewMode,
    getViewMode,
    redrawLineType,
    fitToView,
    resetView,
    isWorldPointVisible,
    getSvgElement: () => svg,
    zoomBy,
    resetZoomToActual,
    setZoomChangeHandler,
  };
})(window.Genogram);
