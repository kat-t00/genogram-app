// アプリ全体の組み立て：起動時の初期化とツールバー・備考欄・右クリックメニューの結線。
// （Pythonのmain_window.pyに相当）

(function (Genogram) {
  let currentDocument = null;
  let currentFileName = null;

  // ===== 元に戻す・やり直し =====
  // documentを丸ごとJSON文字列でスナップショットし、refreshAll()のたびに直前の
  // 状態と比較する方式。個々の追加・編集・削除など全ての変更箇所に手を入れずに
  // 一箇所（refreshAll）だけで履歴を取れるのが利点。
  let undoStack = [];
  let redoStack = [];
  let lastSnapshot = null;
  let isRestoringHistory = false;
  const MAX_HISTORY = 50;

  function resetHistory() {
    undoStack = [];
    redoStack = [];
    lastSnapshot = currentDocument ? JSON.stringify(currentDocument) : null;
    updateUndoRedoButtons();
  }

  function recordHistoryIfChanged() {
    if (isRestoringHistory) return;
    const snapshot = JSON.stringify(currentDocument);
    if (lastSnapshot !== null && lastSnapshot !== snapshot) {
      undoStack.push(lastSnapshot);
      if (undoStack.length > MAX_HISTORY) undoStack.shift();
      redoStack = [];
    }
    lastSnapshot = snapshot;
  }

  function restoreSnapshot(jsonText) {
    isRestoringHistory = true;
    currentDocument = Genogram.createDocument(JSON.parse(jsonText));
    document.getElementById("note-textarea").value = currentDocument.overallNote || "";
    refreshAll();
    lastSnapshot = jsonText;
    isRestoringHistory = false;
    updateUndoRedoButtons();
  }

  function undo() {
    if (undoStack.length === 0) return;
    redoStack.push(JSON.stringify(currentDocument));
    restoreSnapshot(undoStack.pop());
  }

  function redo() {
    if (redoStack.length === 0) return;
    undoStack.push(JSON.stringify(currentDocument));
    restoreSnapshot(redoStack.pop());
  }

  function updateUndoRedoButtons() {
    const undoButton = document.getElementById("btn-undo");
    const redoButton = document.getElementById("btn-redo");
    if (undoButton) undoButton.disabled = undoStack.length === 0;
    if (redoButton) redoButton.disabled = redoStack.length === 0;
  }

  function buildSubjectPerson(info) {
    const subjectInfo = info || {};
    return Genogram.createPerson({
      id: "p1",
      name: subjectInfo.name || "本人",
      age: subjectInfo.age || null,
      gender: subjectInfo.gender || Genogram.Gender.UNKNOWN,
      relationToSubject: "本人",
      x: 400,
      y: 300,
    });
  }

  function buildFreshDocument(subjectInfo) {
    const doc = Genogram.createDocument({
      caseId: Genogram.documentStore.makeCaseId(),
      caseLabel: (subjectInfo && subjectInfo.caseLabel) || "",
    });
    const subject = buildSubjectPerson(subjectInfo);
    doc.subjectId = subject.id;
    doc.persons.push(subject);
    return doc;
  }

  // 「🆕新しいジェノグラムを作成」モーダルで本人の名前(必須)・年齢・性別・メモを入力してもらい、
  // 確定したらonConfirmへ、キャンセルしたらonCancelへ進む（最初から作成・初回起動の両方で使う）。
  function openNewCaseModal(onConfirm, onCancel) {
    const modal = document.getElementById("new-case-modal");
    const nameInput = document.getElementById("new-case-name");
    const ageInput = document.getElementById("new-case-age");
    const genderSelect = document.getElementById("new-case-gender");
    const labelInput = document.getElementById("new-case-label");
    const confirmButton = document.getElementById("new-case-confirm");
    const cancelButton = document.getElementById("new-case-cancel");

    nameInput.value = "";
    ageInput.value = "";
    genderSelect.value = "unknown";
    labelInput.value = "";
    modal.classList.remove("hidden");
    nameInput.focus();

    function cleanup() {
      modal.classList.add("hidden");
      confirmButton.removeEventListener("click", handleConfirm);
      cancelButton.removeEventListener("click", handleCancel);
    }
    function handleConfirm() {
      const name = nameInput.value.trim();
      if (!name) {
        nameInput.focus();
        return; // 名前は必須。空のまま進ませない
      }
      cleanup();
      onConfirm({
        name,
        age: ageInput.value.trim(),
        gender: genderSelect.value,
        caseLabel: labelInput.value.trim(),
      });
    }
    function handleCancel() {
      cleanup();
      if (onCancel) onCancel();
    }
    confirmButton.addEventListener("click", handleConfirm);
    cancelButton.addEventListener("click", handleCancel);
  }

  function loadIntoApp(doc) {
    currentDocument = doc;
    document.getElementById("note-textarea").value = doc.overallNote || "";
    resetHistory();
    refreshAll();
    // 別の事例を表示していた時のパン・ズーム位置が残っていると、新しい事例の
    // 人物が画面外に表示されてしまう（見当たらない）ため、毎回表示位置を合わせ直す
    Genogram.canvas.fitToView(currentDocument);
  }

  // ドキュメントを変更した（家族・関係機関の追加・編集・削除、レイアウト再計算など）後に
  // 呼び出すと、キャンバス・左側リスト・選択肢をまとめて最新の状態に描き直す。
  function refreshAll() {
    recordHistoryIfChanged();
    Genogram.canvas.renderDocument(currentDocument);
    Genogram.forms.refreshConnectPersonOptions();
    Genogram.forms.refreshInstitutionConnectOptions();
    Genogram.forms.renderFamilyList(currentDocument);
    Genogram.forms.renderInstitutionList(currentDocument);
    Genogram.forms.renderConnectList(currentDocument);
    Genogram.forms.renderInstitutionConnectList(currentDocument);
    Genogram.forms.renderGroupList(currentDocument);
    Genogram.forms.refreshGroupMemberCheckboxesIfIdle();
    Genogram.documentStore.autosaveCase(currentDocument);
    renderCaseList();
    updateUndoRedoButtons();
    showSavedToast();
  }

  // 自動保存のたびに画面の隅へさりげなく「保存しました」を表示する。
  // 操作に不慣れな人ほど「本当に保存されているのか」が分かりにくいための安心材料。
  let saveToastHideTimer = null;
  function showSavedToast() {
    const toast = document.getElementById("save-toast");
    if (!toast) return;
    toast.classList.remove("hidden");
    requestAnimationFrame(() => toast.classList.add("visible"));
    clearTimeout(saveToastHideTimer);
    saveToastHideTimer = setTimeout(() => {
      toast.classList.remove("visible");
      setTimeout(() => toast.classList.add("hidden"), 250);
    }, 1200);
  }

  // 入力フォーム（サイドパネル）・備考欄は、端末によってはジェノグラム・エコマップの
  // 表示領域を狭く感じさせるため、引き出し式に折りたためるようにする。
  // 開閉状態はlocalStorageに保存し、次回開いた時も同じ状態を保つ。
  const PANEL_STATE_KEY = "genogram_panel_state";

  function loadPanelState() {
    try {
      return JSON.parse(localStorage.getItem(PANEL_STATE_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function savePanelState(state) {
    localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(state));
  }

  function setupPanelToggles() {
    const state = loadPanelState();
    const sideToggle = document.getElementById("btn-toggle-sidepanel");
    const noteToggle = document.getElementById("btn-toggle-notepanel");

    function applySideState(collapsed) {
      document.body.classList.toggle("side-panel-collapsed", collapsed);
      sideToggle.classList.toggle("is-open", !collapsed);
    }

    function applyNoteState(collapsed) {
      document.body.classList.toggle("note-panel-collapsed", collapsed);
      noteToggle.classList.toggle("is-open", !collapsed);
    }

    applySideState(!!state.sideCollapsed);
    applyNoteState(!!state.noteCollapsed);

    sideToggle.addEventListener("click", () => {
      const collapsed = !document.body.classList.contains("side-panel-collapsed");
      applySideState(collapsed);
      savePanelState({ ...loadPanelState(), sideCollapsed: collapsed });
    });

    noteToggle.addEventListener("click", () => {
      const collapsed = !document.body.classList.contains("note-panel-collapsed");
      applyNoteState(collapsed);
      savePanelState({ ...loadPanelState(), noteCollapsed: collapsed });
    });
  }

  // 今のズーム倍率（％）を表示し、＋／－ボタン・表示自体のクリックで
  // 拡大縮小・標準サイズ(100%)への復帰ができるようにする。
  function setupZoomControl() {
    const zoomLabel = document.getElementById("btn-zoom-reset");
    Genogram.canvas.setZoomChangeHandler((percent) => {
      zoomLabel.textContent = `${percent}%`;
    });
    document.getElementById("btn-zoom-in").addEventListener("click", () => {
      Genogram.canvas.zoomBy(1.2);
    });
    document.getElementById("btn-zoom-out").addEventListener("click", () => {
      Genogram.canvas.zoomBy(1 / 1.2);
    });
    zoomLabel.addEventListener("click", () => {
      Genogram.canvas.resetZoomToActual();
    });
  }

  function defaultFileBaseName() {
    const subject = currentDocument.persons.find((p) => p.id === currentDocument.subjectId);
    return subject ? subject.name : "genogram";
  }

  // 使い方ガイド等の.modal-overlay系ポップアップは全て共通で、
  // ボックスの外側（半透明の背景部分）をクリックしたら閉じる。
  // モーダルごとに個別実装すると漏れが出るため、ここで一括対応する。
  function setupModalOutsideClickClose() {
    document.querySelectorAll(".modal-overlay").forEach((overlay) => {
      overlay.addEventListener("click", (evt) => {
        if (evt.target === overlay) overlay.classList.add("hidden");
      });
    });
  }

  function setupToolbar() {
    document.getElementById("btn-new").addEventListener("click", () => {
      openNewCaseModal((subjectInfo) => {
        loadIntoApp(buildFreshDocument(subjectInfo));
        currentFileName = null;
      });
    });

    document.getElementById("btn-open").addEventListener("click", () => {
      document.getElementById("file-input").click();
    });

    document.getElementById("file-input").addEventListener("change", (evt) => {
      const file = evt.target.files[0];
      if (!file) return;
      Genogram.documentStore
        .loadDocumentFromFile(file)
        .then((doc) => {
          if (!doc.caseId) doc.caseId = Genogram.documentStore.makeCaseId();
          loadIntoApp(doc);
          currentFileName = file.name;
        })
        .catch(() => alert("ファイルを読み込めませんでした。"))
        .finally(() => {
          evt.target.value = "";
        });
    });

    document.getElementById("btn-save-file").addEventListener("click", promptAndSave);

    document.getElementById("btn-export-png").addEventListener("click", () => openExportOptions("png"));
    document.getElementById("btn-export-pdf").addEventListener("click", () => openExportOptions("pdf"));

    document.getElementById("btn-tidy").addEventListener("click", () => {
      // 整頓は手動でドラッグした分も含めて全員を自動レイアウトに戻す
      Genogram.relationRules.resetManualPositions(currentDocument);
      Genogram.relationRules.recomputeLayout(currentDocument);
      Genogram.relationRules.recomputeInstitutionLayout(currentDocument);
      refreshAll();
    });

    document.getElementById("btn-fit-view").addEventListener("click", () => {
      Genogram.canvas.fitToView(currentDocument);
    });

    setupPanelToggles();
    setupZoomControl();

    document.getElementById("btn-add-person").addEventListener("click", () => {
      Genogram.forms.focusAddForm();
    });

    document.getElementById("btn-undo").addEventListener("click", undo);
    document.getElementById("btn-redo").addEventListener("click", redo);
    document.addEventListener("keydown", (evt) => {
      if (!(evt.ctrlKey || evt.metaKey) || evt.key.toLowerCase() !== "z") return;
      evt.preventDefault();
      if (evt.shiftKey) redo();
      else undo();
    });

    document.querySelectorAll(".view-mode-button").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll(".view-mode-button").forEach((b) => b.classList.remove("active"));
        button.classList.add("active");
        Genogram.canvas.setViewMode(button.dataset.view);
      });
    });
  }

  // ===== 📁保存一覧（複数のジェノグラムを本人の名前で管理）=====

  function renderCaseList() {
    const list = document.getElementById("case-list");
    if (!list) return;
    list.innerHTML = "";
    const cases = Genogram.documentStore.listCases();
    if (cases.length === 0) {
      const li = document.createElement("li");
      li.textContent = "まだ保存されたジェノグラムはありません。";
      list.appendChild(li);
      return;
    }
    cases.forEach((entry) => {
      const li = document.createElement("li");
      li.className = "connection-row";
      if (currentDocument && entry.id === currentDocument.caseId) li.classList.add("editing");

      const main = document.createElement("span");
      main.className = "entity-main";
      main.textContent = entry.label ? `${entry.name}（${entry.label}）` : entry.name;
      const sub = document.createElement("span");
      sub.className = "entity-sub";
      sub.textContent = new Date(entry.updatedAt).toLocaleString("ja-JP");

      const labelButton = document.createElement("button");
      labelButton.type = "button";
      labelButton.className = "entity-delete";
      labelButton.title = "メモを編集";
      labelButton.textContent = "✏️";
      labelButton.addEventListener("click", () => {
        const newLabel = window.prompt(
          "一覧で見分けやすくするメモを入力してください（例：研修用、2026年7月 主任ケアマネ研修）",
          entry.label || ""
        );
        if (newLabel === null) return;
        Genogram.documentStore.updateCaseLabel(entry.id, newLabel.trim());
        renderCaseList();
      });

      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.className = "secondary-button case-open-button";
      openButton.textContent = "開く";
      openButton.addEventListener("click", () => {
        const doc = Genogram.documentStore.loadCase(entry.id);
        if (!doc) return;
        loadIntoApp(doc);
        currentFileName = null;
        document.getElementById("case-list-modal").classList.add("hidden");
      });

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "entity-delete";
      deleteButton.textContent = "🗑";
      deleteButton.addEventListener("click", () => {
        if (!window.confirm(`「${entry.name}」を削除しますか？`)) return;
        Genogram.documentStore.deleteCase(entry.id);
        if (currentDocument && entry.id === currentDocument.caseId) {
          loadIntoApp(buildFreshDocument());
        }
        renderCaseList();
      });

      li.appendChild(main);
      li.appendChild(sub);
      li.appendChild(labelButton);
      li.appendChild(openButton);
      li.appendChild(deleteButton);
      list.appendChild(li);
    });
  }

  function setupCaseList() {
    document.getElementById("btn-case-list").addEventListener("click", () => {
      renderCaseList();
      document.getElementById("case-list-modal").classList.remove("hidden");
    });
    document.getElementById("case-list-close").addEventListener("click", () => {
      document.getElementById("case-list-modal").classList.add("hidden");
    });
  }

  function setupHelpModal() {
    document.getElementById("btn-help").addEventListener("click", () => {
      document.getElementById("help-modal").classList.remove("hidden");
    });
    document.getElementById("help-modal-close").addEventListener("click", () => {
      document.getElementById("help-modal").classList.add("hidden");
    });

    document.getElementById("btn-usage-guide").addEventListener("click", () => {
      document.getElementById("usage-guide-modal").classList.remove("hidden");
    });
    document.getElementById("usage-guide-close").addEventListener("click", () => {
      document.getElementById("usage-guide-modal").classList.add("hidden");
    });
  }

  // ===== 画像・PDF出力オプション（透明背景・モノクロ）をポップアップで聞く =====
  // ヘッダーにチェックボックスを常設すると渋滞するため、出力ボタンを押した時だけ
  // ポップアップでオプションを選んでもらい、そこからダウンロードを実行する。

  let pendingExportType = null; // "png" | "pdf"

  function openExportOptions(type) {
    pendingExportType = type;
    document.getElementById("export-options-title").textContent =
      type === "png" ? "🖼 画像出力" : "📄 PDF出力";
    // 出力時の初期選択は、今キャンバスで見ている表示モードに合わせておく（変更も可能）
    const currentViewMode = Genogram.canvas.getViewMode();
    document.getElementById(`export-view-${currentViewMode}`).checked = true;
    // 作成者名・凡例はPDFだけの項目（画像出力には見出し・凡例欄が無いため）
    document.getElementById("export-pdf-only-options").classList.toggle("hidden", type !== "pdf");
    document.getElementById("export-creator-name").value = currentDocument.creatorName || "";
    document.getElementById("export-orientation-auto").checked = true;
    document.getElementById("export-options-modal").classList.remove("hidden");
  }

  function setupExportOptionsModal() {
    document.getElementById("export-options-cancel").addEventListener("click", () => {
      document.getElementById("export-options-modal").classList.add("hidden");
    });

    document.getElementById("export-options-confirm").addEventListener("click", () => {
      const options = {
        transparent: document.getElementById("export-transparent").checked,
        monochrome: document.getElementById("export-monochrome").checked,
        viewMode: document.querySelector('input[name="export-view-mode"]:checked').value,
      };
      if (pendingExportType === "png") {
        Genogram.exporter.exportToPng(
          Genogram.canvas.getSvgElement(),
          `${defaultFileBaseName()}_genogram.png`,
          options
        );
      } else if (pendingExportType === "pdf") {
        currentDocument.creatorName = document.getElementById("export-creator-name").value.trim();
        Genogram.documentStore.autosaveCase(currentDocument);
        options.creatorName = currentDocument.creatorName;
        options.includeLegend = document.getElementById("export-include-legend").checked;
        options.orientation = document.querySelector('input[name="export-orientation"]:checked').value;
        Genogram.exporter.exportToPdf(
          Genogram.canvas.getSvgElement(),
          `${defaultFileBaseName()} ジェノグラム・エコマップ`,
          currentDocument.overallNote,
          options
        );
      }
      document.getElementById("export-options-modal").classList.add("hidden");
    });
  }

  function promptAndSave() {
    const suggested = currentFileName || `${defaultFileBaseName()}_genogram.json`;
    const fileName = window.prompt("保存するファイル名を入力してください", suggested);
    if (!fileName) return;
    currentFileName = fileName;
    Genogram.documentStore.saveDocument(currentDocument, fileName);
  }

  function setupNote() {
    document.getElementById("note-textarea").addEventListener("input", (evt) => {
      currentDocument.overallNote = evt.target.value;
      Genogram.documentStore.autosaveCase(currentDocument);
    });
  }

  // 何もないキャンバス上でのクイックメニュー（左クリック・右クリックどちらでも開く）。
  // ツールバーのボタンと同じ操作を、図のすぐそばからも呼び出せるようにするためのもの。
  function setupCanvasBackgroundMenu() {
    const menu = document.getElementById("canvas-context-menu");

    Genogram.canvas.setCanvasBackgroundClickHandler((clientX, clientY) => {
      // 既に開いている状態でまた背景をタップ/クリックしたら、開き直さずに閉じる
      // （タップするたびに開閉がトグルされる方が分かりやすいため）
      if (!menu.classList.contains("hidden")) {
        menu.classList.add("hidden");
        return;
      }
      menu.style.left = `${clientX}px`;
      menu.style.top = `${clientY}px`;
      menu.classList.remove("hidden");
    });

    menu.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.dataset.action;
        if (action === "add-person") {
          Genogram.forms.focusAddForm();
        } else if (action === "add-institution") {
          document.querySelector('.tab-button[data-tab="institution"]').click();
          document.getElementById("institution-name").focus();
        } else if (action === "tidy") {
          Genogram.relationRules.resetManualPositions(currentDocument);
          Genogram.relationRules.recomputeLayout(currentDocument);
          Genogram.relationRules.recomputeInstitutionLayout(currentDocument);
          refreshAll();
        } else if (action === "fit") {
          Genogram.canvas.fitToView(currentDocument);
        }
        menu.classList.add("hidden");
      });
    });

    // captureフェーズのpointerdownで判定する。bubbleフェーズのclickで判定すると、
    // メニューを開いた直後の同じクリックがdocumentまでバブリングして
    // 即座に閉じてしまうバグになる（人物ポップアップと同じ理由）。
    document.addEventListener(
      "pointerdown",
      (evt) => {
        if (evt.target === Genogram.canvas.getSvgElement()) return;
        if (!menu.contains(evt.target)) menu.classList.add("hidden");
      },
      true
    );
  }

  function setupLineContextMenu() {
    const menu = document.getElementById("line-context-menu");
    let activeLink = null;

    Genogram.canvas.setLineContextMenuHandler((linkRef, clientX, clientY) => {
      activeLink = linkRef;
      // 樹形図の枝（自動生成された親子バー）は反転の対象外にする
      document.getElementById("line-context-reverse").classList.toggle("hidden", !!linkRef.__familyStem);
      // 別居・離婚マークは配偶者関係の線にだけ意味がある
      document
        .getElementById("line-context-marital")
        .classList.toggle("hidden", linkRef.__familyStem || linkRef.type !== "spouse");
      menu.style.left = `${clientX}px`;
      menu.style.top = `${clientY}px`;
      menu.classList.remove("hidden");
    });

    menu.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => {
        if (activeLink) {
          if (button.dataset.action === "delete") {
            deleteActiveLink(activeLink);
          } else if (button.dataset.action === "reverse") {
            reverseActiveLink(activeLink);
          } else if (button.dataset.marital !== undefined) {
            activeLink.maritalStatus = button.dataset.marital || null;
            Genogram.canvas.redrawLineType(activeLink);
          } else if (activeLink.__familyStem) {
            // 樹形図の枝（自動生成された親子バー）を右クリックで変更した場合は、
            // 対象の関係線をすべて手動扱いにして、次の描画から個別線として表示する
            activeLink.relIds.forEach((id) => {
              const relationship = currentDocument.relationships.find((r) => r.id === id);
              if (relationship) {
                relationship.type = button.dataset.type;
                relationship.isAuto = false;
              }
            });
            refreshAll();
          } else {
            activeLink.type = button.dataset.type;
            activeLink.isAuto = false;
            Genogram.canvas.redrawLineType(activeLink);
          }
        }
        menu.classList.add("hidden");
      });
    });

    document.addEventListener("click", () => menu.classList.add("hidden"));
    document.querySelector(".canvas-wrap").addEventListener("contextmenu", (evt) => {
      if (evt.target.tagName.toLowerCase() === "svg") evt.preventDefault();
    });
  }

  function deleteActiveLink(activeLink) {
    if (activeLink.__familyStem) {
      if (!window.confirm("この枝の関係線を削除しますか？")) return;
      activeLink.relIds.forEach((id) => {
        const rel = currentDocument.relationships.find((r) => r.id === id);
        if (rel) Genogram.relationRules.markPairSevered(currentDocument, rel.personAId, rel.personBId);
      });
      currentDocument.relationships = currentDocument.relationships.filter(
        (r) => !activeLink.relIds.includes(r.id)
      );
    } else if ("fromId" in activeLink) {
      if (!window.confirm("この関係を削除しますか？")) return;
      currentDocument.institutionLinks = currentDocument.institutionLinks.filter(
        (l) => l.id !== activeLink.id
      );
    } else {
      if (!window.confirm("この関係を削除しますか？")) return;
      Genogram.relationRules.markPairSevered(currentDocument, activeLink.personAId, activeLink.personBId);
      currentDocument.relationships = currentDocument.relationships.filter((r) => r.id !== activeLink.id);
    }
    refreshAll();
  }

  // 「働きかけ（矢印）」の向きはpersonAId→personBId（institutionLinkはfromId→toId）の
  // 順序で決まる。あとから矢印の向きだけ変えたい場合に、その順序を入れ替える。
  function reverseActiveLink(activeLink) {
    if (activeLink.__familyStem) return; // 樹形図の枝は対象外
    if ("fromId" in activeLink) {
      const temp = activeLink.fromId;
      activeLink.fromId = activeLink.toId;
      activeLink.toId = temp;
    } else {
      const temp = activeLink.personAId;
      activeLink.personAId = activeLink.personBId;
      activeLink.personBId = temp;
    }
    refreshAll();
  }

  function getDocument() {
    return currentDocument;
  }

  function setupNodeClicks() {
    Genogram.canvas.setPersonClickHandler((person, clientX, clientY) =>
      Genogram.forms.openPersonPopup(person, clientX, clientY)
    );
    Genogram.canvas.setInstitutionClickHandler((institution, clientX, clientY) =>
      Genogram.forms.openInstitutionPopup(institution, clientX, clientY)
    );
    Genogram.canvas.setGroupClickHandler((group) => Genogram.forms.startEditGroup(group));
    // ドラッグだけで他の操作をしなかった場合も、位置の変更が保存されるようにする
    Genogram.canvas.setDragEndHandler(() => refreshAll());
  }

  Genogram.app = { getDocument, refreshAll };

  window.addEventListener("DOMContentLoaded", () => {
    Genogram.canvas.init(document.getElementById("canvas"));
    Genogram.forms.setup();
    Genogram.comboBox.setupAll();
    setupToolbar();
    setupNote();
    setupLineContextMenu();
    setupCanvasBackgroundMenu();
    setupNodeClicks();
    setupCaseList();
    setupHelpModal();
    setupExportOptionsModal();
    setupModalOutsideClickClose();

    // 複数ケース対応より前の単一自動保存が残っていれば、1件目のケースとして取り込む
    const migrated = Genogram.documentStore.migrateLegacyAutosaveIfNeeded();
    const cases = Genogram.documentStore.listCases();
    const initialDoc = migrated || (cases.length > 0 ? Genogram.documentStore.loadCase(cases[0].id) : null);
    if (initialDoc) {
      loadIntoApp(initialDoc);
    } else {
      // 初めての起動時は、まず本人の情報を入力してもらうところからスタートする
      openNewCaseModal(
        (subjectInfo) => loadIntoApp(buildFreshDocument(subjectInfo)),
        () => loadIntoApp(buildFreshDocument())
      );
    }
  });
})(window.Genogram);
