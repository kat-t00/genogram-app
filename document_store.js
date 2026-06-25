// ドキュメントの保存（ファイルダウンロード）・読込（ファイル選択）・
// 端末への自動保存（複数ケースを名前で管理）を担当する。
// （Pythonのdocument_store.pyに相当）

(function (Genogram) {
  // 古い保存データには anchorPersonId が存在しない。未設定のままでも
  // resolveAnchorId側で「本人を基準」として扱われるが、データを明示的に
  // 補完しておくことで挙動が分かりやすくなる（後方互換のための移行処理）。
  function normalizeDocument(doc) {
    doc.persons.forEach((p) => {
      if (p.anchorPersonId === undefined) p.anchorPersonId = null;
    });
    return doc;
  }

  function saveDocument(doc, fileName) {
    const json = JSON.stringify(doc, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function loadDocumentFromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          resolve(normalizeDocument(Genogram.createDocument(data)));
        } catch (error) {
          reject(error);
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  // ===== 端末への自動保存（複数ケース対応）=====
  // 1ケース＝1人の本人。caseIdごとに本体を保存し、本人の名前・更新日時だけの
  // 軽い索引(CASE_INDEX_KEY)を別に持つことで、一覧表示のたびに全件を
  // 読み込まなくても済むようにしている。

  const CASE_PREFIX = "genogram_case_v1_";
  const CASE_INDEX_KEY = "genogram_case_index_v1";
  const LEGACY_AUTOSAVE_KEY = "genogram_autosave_v1"; // 複数ケース対応より前の単一自動保存（移行用）

  function makeCaseId() {
    return window.crypto && window.crypto.randomUUID
      ? window.crypto.randomUUID()
      : `case_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function subjectNameOf(doc) {
    const subject = doc.persons.find((p) => p.id === doc.subjectId);
    return (subject && subject.name) || "（名前未設定）";
  }

  function loadCaseIndex() {
    try {
      const raw = localStorage.getItem(CASE_INDEX_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (error) {
      return [];
    }
  }

  function saveCaseIndex(index) {
    try {
      localStorage.setItem(CASE_INDEX_KEY, JSON.stringify(index));
    } catch (error) {
      // 保存容量超過などで失敗しても、ここで落ちると操作が止まってしまうため握り潰す
    }
  }

  function autosaveCase(doc) {
    if (!doc.caseId) doc.caseId = makeCaseId();
    try {
      localStorage.setItem(CASE_PREFIX + doc.caseId, JSON.stringify(doc));
    } catch (error) {
      return;
    }
    const index = loadCaseIndex();
    const entry = {
      id: doc.caseId,
      name: subjectNameOf(doc),
      label: doc.caseLabel || "",
      updatedAt: Date.now(),
    };
    const existingIndex = index.findIndex((e) => e.id === doc.caseId);
    if (existingIndex >= 0) index[existingIndex] = entry;
    else index.push(entry);
    saveCaseIndex(index);
  }

  // 保存データ一覧からメモだけを書き換えたいとき用（ケースを開かずにラベルだけ更新する）
  function updateCaseLabel(caseId, label) {
    const doc = loadCase(caseId);
    if (!doc) return;
    doc.caseLabel = label;
    autosaveCase(doc);
  }

  function loadCase(caseId) {
    try {
      const raw = localStorage.getItem(CASE_PREFIX + caseId);
      return raw ? normalizeDocument(Genogram.createDocument(JSON.parse(raw))) : null;
    } catch (error) {
      return null;
    }
  }

  function deleteCase(caseId) {
    localStorage.removeItem(CASE_PREFIX + caseId);
    saveCaseIndex(loadCaseIndex().filter((e) => e.id !== caseId));
  }

  // 更新日時の新しい順
  function listCases() {
    return loadCaseIndex().slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // 複数ケース対応より前の単一自動保存が残っていたら、1件目のケースとして
  // 取り込んでから古いキーを消す。最初の起動時に一度だけ呼べばよい。
  function migrateLegacyAutosaveIfNeeded() {
    let doc = null;
    try {
      const raw = localStorage.getItem(LEGACY_AUTOSAVE_KEY);
      if (raw) doc = Genogram.createDocument(JSON.parse(raw));
    } catch (error) {
      doc = null;
    }
    if (doc) {
      autosaveCase(doc);
    }
    localStorage.removeItem(LEGACY_AUTOSAVE_KEY);
    return doc;
  }

  Genogram.documentStore = {
    saveDocument,
    loadDocumentFromFile,
    makeCaseId,
    autosaveCase,
    updateCaseLabel,
    loadCase,
    deleteCase,
    listCases,
    migrateLegacyAutosaveIfNeeded,
  };
})(window.Genogram);
