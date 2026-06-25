// 画像（PNG）出力・PDF出力（ブラウザの印刷機能を利用）。
// （Pythonのcanvas_view.export_to_png() / pdf_export.pyに相当）

(function (Genogram) {
  // 表示モード（両方/ジェノグラムのみ/エコマップのみ）に応じて隠す要素のCSSセレクタ。
  // 出力物はscreen用の外部スタイルシート(style.css)を読まないスタンドアロンSVGになるため、
  // 画面上の表示・非表示（CSSクラス）に頼らず、ここでinline style="display:none"を直接付与する。
  function selectorsToHideFor(viewMode) {
    const selectors = ["#layer-interaction"];
    if (viewMode === "genogram") {
      selectors.push(".institution-node", ".institution-link-line", ".ecomap-group-boundary", ".ecomap-group-label");
    } else if (viewMode === "ecomap") {
      selectors.push(".relationship-line", ".family-tree-connector", ".cohabiting-boundary", ".cohabiting-boundary-hit");
    }
    return selectors;
  }

  // 同居枠の当たり判定だけの透明な図形や、表示モードで隠している図形・線は
  // 出力物にも不要なので、計測・書き出しの両方から除外する。
  // display:noneにしている間はgetBBox()の計算からも自動的に除外される。
  function withHiddenExportLayers(svgElement, callback, viewMode) {
    const elementsToHide = selectorsToHideFor(viewMode || "both").flatMap((selector) =>
      Array.from(svgElement.querySelectorAll(selector))
    );
    const previousDisplay = elementsToHide.map((el) => el.style.display);
    elementsToHide.forEach((el) => {
      el.style.display = "none";
    });
    try {
      return callback();
    } finally {
      elementsToHide.forEach((el, index) => {
        el.style.display = previousDisplay[index];
      });
    }
  }

  function getContentBBox(svgElement) {
    const bbox = svgElement.getBBox();
    const margin = 20;
    return {
      x: bbox.x - margin,
      y: bbox.y - margin,
      width: bbox.width + margin * 2,
      height: bbox.height + margin * 2,
    };
  }

  // 図形は白塗り＋黒線、文字は黒、矢印など線の装飾は黒塗りにする。
  // 当たり判定専用の透明な線（stroke="transparent"）は対象外。
  function applyMonochrome(svgClone) {
    svgClone
      .querySelectorAll(".person-node rect, .person-node circle, .person-node polygon, .institution-node rect")
      .forEach((el) => {
        el.setAttribute("fill", "#ffffff");
        el.setAttribute("stroke", "#000000");
      });
    svgClone.querySelectorAll(".person-node text, .person-node tspan, .institution-node text, .institution-node tspan").forEach((el) => {
      el.setAttribute("fill", "#000000");
    });
    svgClone.querySelectorAll(".deceased-mark").forEach((el) => {
      el.setAttribute("stroke", "#000000");
    });
    svgClone.querySelectorAll(".relationship-line, .institution-link-line, .family-tree-connector").forEach((group) => {
      group.querySelectorAll("line, polygon").forEach((el) => {
        if (el.getAttribute("stroke") === "transparent") return;
        el.setAttribute("stroke", "#000000");
        if (el.tagName.toLowerCase() === "polygon") el.setAttribute("fill", "#000000");
      });
    });
    const boundary = svgClone.querySelector(".cohabiting-boundary");
    if (boundary) {
      boundary.setAttribute("fill", "none");
      boundary.setAttribute("stroke", "#000000");
    }
    svgClone.querySelectorAll(".ecomap-group-boundary").forEach((el) => {
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", "#000000");
    });
    svgClone.querySelectorAll(".ecomap-group-label").forEach((el) => {
      el.setAttribute("fill", "#000000");
    });
  }

  function buildExportSvg(svgElement, bbox, options) {
    const clone = svgElement.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", bbox.width);
    clone.setAttribute("height", bbox.height);
    clone.setAttribute("viewBox", `${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height}`);

    if (options && options.monochrome) {
      applyMonochrome(clone);
    }

    // 透明背景を選んでいない場合だけ、背景を白っぽい色で塗っておく
    // （透明だと共有時に背景が見えにくいことがあるため）。
    if (!(options && options.transparent)) {
      const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      background.setAttribute("x", bbox.x);
      background.setAttribute("y", bbox.y);
      background.setAttribute("width", bbox.width);
      background.setAttribute("height", bbox.height);
      background.setAttribute("fill", options && options.monochrome ? "#ffffff" : "#fffdf9");
      clone.insertBefore(background, clone.firstChild);
    }
    return clone;
  }

  function exportToPng(svgElement, fileName, options) {
    const viewMode = (options && options.viewMode) || "both";
    const bbox = withHiddenExportLayers(svgElement, () => getContentBBox(svgElement), viewMode);
    const exportSvg = withHiddenExportLayers(svgElement, () => buildExportSvg(svgElement, bbox, options), viewMode);
    const svgString = new XMLSerializer().serializeToString(exportSvg);
    const svgBlob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);

    const img = new Image();
    img.onload = () => {
      const scale = 2; // 高解像度で書き出す
      const canvas = document.createElement("canvas");
      canvas.width = bbox.width * scale;
      canvas.height = bbox.height * scale;
      const ctx = canvas.getContext("2d");
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, bbox.width, bbox.height);
      URL.revokeObjectURL(url);

      canvas.toBlob((blob) => {
        const downloadUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = downloadUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(downloadUrl);
      }, "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      alert("画像出力に失敗しました。");
    };
    img.src = url;
  }

  function exportToPdf(svgElement, title, noteText, options) {
    const viewMode = (options && options.viewMode) || "both";
    const bbox = withHiddenExportLayers(svgElement, () => getContentBBox(svgElement), viewMode);
    const exportSvg = withHiddenExportLayers(svgElement, () => buildExportSvg(svgElement, bbox, options), viewMode);
    // width/heightの属性を両方残すと（片方だけ%にする等）縦横比が崩れてA4に収まらなくなるため、
    // 両方とも外してCSS側のwidth:100%;height:auto;（viewBoxに基づく自動計算）に任せる。
    exportSvg.removeAttribute("width");
    exportSvg.removeAttribute("height");

    const printArea = document.getElementById("print-area");
    printArea.innerHTML = "";

    const heading = document.createElement("h2");
    heading.textContent = title;
    printArea.appendChild(heading);

    // 記録としての正確性のため、出力日（今日の日付）と作成者名（任意入力）をヘッダーに残す
    const todayLabel = new Date().toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" });
    const metaParts = [`作成日：${todayLabel}`];
    if (options && options.creatorName) metaParts.push(`作成者：${options.creatorName}`);
    const meta = document.createElement("p");
    meta.className = "print-meta";
    meta.textContent = metaParts.join("　");
    printArea.appendChild(meta);

    // 向きは「自動」（図の形に合わせる）か、ユーザーが横／縦を明示的に選んだかのどちらか。
    // 縦長のまま横長の図を印刷すると、用紙の幅いっぱいまでしか拡大できず上下に大きな
    // 余白が残ってしまうため、デフォルトは自動判定にしている。
    const orientation = (options && options.orientation) || "auto";
    const isLandscape = orientation === "auto" ? bbox.width > bbox.height : orientation === "landscape";
    printArea.classList.toggle("orientation-landscape", isLandscape);
    printArea.classList.toggle("orientation-portrait", !isLandscape);

    // 図と、凡例・備考をまとめた本文エリア。横向きの時は図と凡例・備考を左右に並べ、
    // 縦向きの時は図の下に縦に並べる（このクラス切り替えはCSS側のorientation-landscapeで行う）。
    const body = document.createElement("div");
    body.className = "print-body";
    printArea.appendChild(body);

    const diagramCol = document.createElement("div");
    diagramCol.className = "print-diagram-col";
    const svgWrap = document.createElement("div");
    svgWrap.className = "print-svg-wrap";
    svgWrap.appendChild(exportSvg);
    diagramCol.appendChild(svgWrap);
    body.appendChild(diagramCol);

    const textCol = document.createElement("div");
    textCol.className = "print-text-col";
    body.appendChild(textCol);

    if (options && options.includeLegend) {
      const legendBlock = document.createElement("div");
      legendBlock.className = "print-legend";
      const legendHeading = document.createElement("h3");
      legendHeading.textContent = "図形・線の意味";
      const legendList = document.createElement("ul");
      [
        "四角＝男性／○＝女性／◇＝性別不明",
        "二重線の図形＝本人",
        "実線＝普通の関係／二重線＝強い関係／破線＝弱い関係／ギザギザ線＝対立／矢印＝一方向的な働きかけ",
        "点線の枠＝同居家族またはグループ",
        "結婚線の斜線1本＝別居／2本＝離婚",
        "図形の×印＝故人（死亡）／★＝キーパーソン（主たる介護者・連絡先）",
      ].forEach((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        legendList.appendChild(li);
      });
      legendBlock.appendChild(legendHeading);
      legendBlock.appendChild(legendList);
      textCol.appendChild(legendBlock);
    }

    if (noteText) {
      const noteBlock = document.createElement("div");
      noteBlock.className = "print-note";
      const noteHeading = document.createElement("h3");
      noteHeading.textContent = "📝 備考（事例検討メモなど）";
      const noteBody = document.createElement("p");
      noteBody.style.whiteSpace = "pre-wrap";
      noteBody.textContent = noteText;
      noteBlock.appendChild(noteHeading);
      noteBlock.appendChild(noteBody);
      textCol.appendChild(noteBlock);
    }

    let pageStyle = document.getElementById("print-page-style");
    if (!pageStyle) {
      pageStyle = document.createElement("style");
      pageStyle.id = "print-page-style";
      document.head.appendChild(pageStyle);
    }
    pageStyle.textContent = `@page { size: ${isLandscape ? "landscape" : "portrait"}; margin: 10mm; }`;

    // A4からmargin10mmずつを引いた印刷可能エリアの高さ（少し余裕を持たせて2mm引く）。
    // ここにprint-areaの高さを固定し、見出し・本文エリアでflexに分け合わせることで
    // 図が縦長・備考が長い場合でも2ページ目に溢れないようにする。
    printArea.style.height = isLandscape ? "188mm" : "275mm";

    window.print();
  }

  Genogram.exporter = { exportToPng, exportToPdf };
})(window.Genogram);
