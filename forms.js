// 左パネルの「家族追加」「関係機関登録」フォームの処理。
// 新規追加だけでなく、一覧リストのクリック・ノードクリックからの編集・削除も
// すべてここで扱う。
// （Pythonのfamily_form_widget.py + institution_form_widget.pyに相当）

(function (Genogram) {
  let editingPersonId = null;
  let editingInstitutionId = null;
  let editingGroupId = null;

  function makeId(prefix) {
    const random = (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID().replace(/-/g, "").slice(0, 8)
      : Math.random().toString(16).slice(2, 10);
    return `${prefix}_${random}`;
  }

  // 性別はジェノグラムの図形（四角=男性・丸=女性）に直結するため、
  // 内部的にはmale/female/unknownの3値で持つ。入力欄は日本語ラベルの
  // ポップアップ候補＋手入力を両方許すため、ラベル文字列とコードを相互変換する。
  function mapGenderLabelToCode(label) {
    if (label === "男性") return Genogram.Gender.MALE;
    if (label === "女性") return Genogram.Gender.FEMALE;
    return Genogram.Gender.UNKNOWN;
  }

  function mapGenderCodeToLabel(code) {
    if (code === Genogram.Gender.MALE) return "男性";
    if (code === Genogram.Gender.FEMALE) return "女性";
    return "不明";
  }

  function activateTab(tabName) {
    const button = document.querySelector(`.tab-button[data-tab="${tabName}"]`);
    if (button && !button.classList.contains("active")) button.click();
  }

  function setupTabs() {
    const tabButtons = document.querySelectorAll(".tab-button");
    tabButtons.forEach((button) => {
      button.addEventListener("click", () => {
        tabButtons.forEach((b) => b.classList.remove("active"));
        button.classList.add("active");
        document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.add("hidden"));
        document.getElementById(`tab-${button.dataset.tab}`).classList.remove("hidden");
      });
    });
  }

  const TYPE_LABELS = {
    normal: "普通の関係",
    strong: "強い関係",
    weak: "弱い関係",
    conflict: "対立関係",
    working: "働きかけ",
    spouse: "配偶者関係",
    parent_child: "親子関係",
  };

  // 続柄の表示用ラベル。基準にする人が本人以外の時は「（基準人物名）の（続柄）」の形にする
  // （例：「子テストの配偶者」）ことで、一覧上で「誰の配偶者か」が分かるようにする。
  function personRelationLabel(doc, person) {
    if (person.anchorPersonId && person.anchorPersonId !== doc.subjectId) {
      const anchorPerson = doc.persons.find((p) => p.id === person.anchorPersonId);
      const anchorName = anchorPerson ? anchorPerson.name : "？";
      return `${anchorName}の${person.relationToSubject}`;
    }
    return person.relationToSubject;
  }

  function entityLabel(doc, id) {
    if (id === Genogram.canvas.COHABITING_BOUNDARY_ID) return "同居している世帯全体（枠線）";
    const person = doc.persons.find((p) => p.id === id);
    if (person) return `${person.name}（${personRelationLabel(doc, person)}）`;
    const institution = doc.institutions.find((i) => i.id === id);
    if (institution) return `${institution.name}（機関）`;
    const group = (doc.groups || []).find((g) => g.id === id);
    if (group) return `${group.label}（グループ）`;
    return "（削除済み）";
  }

  // 人物・関係機関を削除する際、グループのメンバーからも一緒に外す
  // （0人になったグループは枠線の意味がなくなるため、グループ自体も消す）。
  function removeIdFromGroups(doc, id) {
    if (!doc.groups) return;
    doc.groups.forEach((group) => {
      group.memberIds = group.memberIds.filter((memberId) => memberId !== id);
    });
    const emptyGroupIds = doc.groups.filter((g) => g.memberIds.length === 0).map((g) => g.id);
    doc.groups = doc.groups.filter((g) => g.memberIds.length > 0);
    emptyGroupIds.forEach((groupId) => {
      doc.institutionLinks = doc.institutionLinks.filter((l) => l.fromId !== groupId && l.toId !== groupId);
    });
  }

  function deleteRelationship(rel) {
    if (!window.confirm("この関係を削除しますか？")) return;
    const doc = Genogram.app.getDocument();
    Genogram.relationRules.markPairSevered(doc, rel.personAId, rel.personBId);
    doc.relationships = doc.relationships.filter((r) => r.id !== rel.id);
    Genogram.app.refreshAll();
  }

  function deleteInstitutionLink(link) {
    if (!window.confirm("この関係を削除しますか？")) return;
    const doc = Genogram.app.getDocument();
    doc.institutionLinks = doc.institutionLinks.filter((l) => l.id !== link.id);
    Genogram.app.refreshAll();
  }

  function renderConnectionRow(list, mainLabel, subLabel, onDelete) {
    const li = document.createElement("li");
    li.className = "connection-row";
    const main = document.createElement("span");
    main.className = "entity-main";
    main.textContent = mainLabel;
    const sub = document.createElement("span");
    sub.className = "entity-sub";
    sub.textContent = subLabel;
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "entity-delete";
    deleteButton.textContent = "🗑";
    deleteButton.addEventListener("click", onDelete);
    li.appendChild(main);
    li.appendChild(sub);
    li.appendChild(deleteButton);
    list.appendChild(li);
  }

  function renderConnectList(doc) {
    const list = document.getElementById("connect-list");
    list.innerHTML = "";
    doc.relationships.forEach((rel) => {
      const label = `${entityLabel(doc, rel.personAId)} ー ${entityLabel(doc, rel.personBId)}`;
      renderConnectionRow(list, label, TYPE_LABELS[rel.type] || rel.type, () => deleteRelationship(rel));
    });
  }

  function renderInstitutionConnectList(doc) {
    const list = document.getElementById("institution-connect-list");
    list.innerHTML = "";
    doc.institutionLinks.forEach((link) => {
      const label = `${entityLabel(doc, link.fromId)} ー ${entityLabel(doc, link.toId)}`;
      renderConnectionRow(list, label, TYPE_LABELS[link.type] || link.type, () => deleteInstitutionLink(link));
    });
  }

  // 人物・関係機関・グループのどれでも選べる共通の選択肢一覧を作る。
  // 「家族同士を手動でつなぐ」「関係機関をつなぐ」の両方で使う。
  // グループは「関係機関をつなぐ」側（includeInstitutions:true）でのみ選択肢に含める
  // （グループ自体への接続はエコマップ的な関係性として扱うため）。
  function buildEntityOptions(doc, includeInstitutions) {
    const options = doc.persons.map((person) => ({
      id: person.id,
      label: `${person.name}（${personRelationLabel(doc, person)}）`,
    }));
    if (includeInstitutions) {
      doc.institutions.forEach((institution) => {
        options.push({ id: institution.id, label: `${institution.name}（機関・${institution.category}）` });
      });
      (doc.groups || []).forEach((group) => {
        options.push({ id: group.id, label: `${group.label}（グループ）` });
      });
      if (doc.persons.some((p) => p.isCohabiting)) {
        options.push({ id: Genogram.canvas.COHABITING_BOUNDARY_ID, label: "同居している世帯全体（枠線）" });
      }
    }
    return options;
  }

  // 「基準にする人」セレクトの選択肢一覧。本人をデフォルト(値"")にし、
  // 自分自身（編集中の人物）は基準にできないので除外する。
  // 本人には名前を併記する（例：「本人（田中さん）」）ことで、一覧の中でも
  // 「本人」がどの人を指すのか一目で分かるようにする。
  function anchorOptionsFor(doc, excludePersonId) {
    const subject = doc.persons.find((p) => p.id === doc.subjectId);
    const subjectLabel = subject && subject.name ? `本人（${subject.name}さん）` : "本人";
    const options = [{ id: "", label: subjectLabel }];
    doc.persons.forEach((person) => {
      if (person.id === doc.subjectId) return;
      if (person.id === excludePersonId) return;
      options.push({ id: person.id, label: `${person.name}（${personRelationLabel(doc, person)}）` });
    });
    return options;
  }

  function refreshAnchorSelect(selectId, doc, excludePersonId, currentAnchorId) {
    const select = document.getElementById(selectId);
    if (!select) return;
    fillSelectWithEntities(select, anchorOptionsFor(doc, excludePersonId), currentAnchorId || "");
  }

  function fillSelectWithEntities(select, options, previousValue) {
    select.innerHTML = "";
    options.forEach((opt) => {
      const option = document.createElement("option");
      option.value = opt.id;
      option.textContent = opt.label;
      select.appendChild(option);
    });
    if (previousValue && options.some((opt) => opt.id === previousValue)) {
      select.value = previousValue;
    }
  }

  // ===== 家族（ジェノグラム側）=====

  // キーパーソン（主たる介護者・連絡先）は1ドキュメントに1人だけという想定なので、
  // 誰かにチェックを入れたら他の全員からは自動的に外す。
  function enforceSingleKeyPerson(doc, keyPersonId) {
    if (!keyPersonId) return;
    doc.persons.forEach((p) => {
      if (p.id !== keyPersonId) p.isKeyPerson = false;
    });
  }

  function fillFamilyForm(person) {
    document.getElementById("family-name").value = person.name;
    document.getElementById("family-age").value = person.age || "";
    document.getElementById("family-gender").value = mapGenderCodeToLabel(person.gender);
    document.getElementById("family-relation").value = person.relationToSubject;
    refreshAnchorSelect("family-anchor", Genogram.app.getDocument(), person.id, person.anchorPersonId);
    document.getElementById("family-cohabiting").checked = person.isCohabiting;
    document.getElementById("family-deceased").checked = person.isDeceased;
    document.getElementById("family-key-person").checked = person.isKeyPerson;
    document.getElementById("family-note").value = person.note || "";
  }

  function startEditPerson(person) {
    const doc = Genogram.app.getDocument();
    const isSubject = person.id === doc.subjectId;
    editingPersonId = person.id;
    fillFamilyForm(person);

    document.getElementById("family-editing-id").value = person.id;
    document.getElementById("family-relation").disabled = isSubject;
    document.getElementById("family-anchor").disabled = isSubject;
    document.getElementById("family-submit-button").textContent = "✓ 更新する";
    document.getElementById("family-cancel-edit").classList.remove("hidden");
    document.getElementById("family-delete-button").classList.toggle("hidden", isSubject);

    activateTab("family");
    renderFamilyList(doc);
  }

  // キャンバス上の「➕ 人物を追加」ボタンから呼ばれる。サイドパネルの追加フォームが
  // スクロールで埋もれて見つけにくい問題への対策として、強制的に先頭まで表示する。
  function focusAddForm() {
    if (editingPersonId) cancelFamilyEdit();
    activateTab("family");
    const panel = document.querySelector(".side-panel");
    if (panel) panel.scrollTop = 0;
    document.getElementById("family-name").focus();
  }

  function cancelFamilyEdit() {
    editingPersonId = null;
    const form = document.getElementById("family-form");
    form.reset();
    document.getElementById("family-editing-id").value = "";
    document.getElementById("family-relation").disabled = false;
    document.getElementById("family-relation").value = "子";
    document.getElementById("family-anchor").disabled = false;
    document.getElementById("family-submit-button").textContent = "＋ 家族を追加";
    document.getElementById("family-cancel-edit").classList.add("hidden");
    document.getElementById("family-delete-button").classList.add("hidden");
    renderFamilyList(Genogram.app.getDocument());
  }

  function deleteCurrentPerson() {
    const doc = Genogram.app.getDocument();
    if (!editingPersonId || editingPersonId === doc.subjectId) return;
    if (!window.confirm("この家族を削除しますか？関連する関係線も削除されます。")) return;

    const id = editingPersonId;
    doc.persons = doc.persons.filter((p) => p.id !== id);
    doc.relationships = doc.relationships.filter((r) => r.personAId !== id && r.personBId !== id);
    doc.institutionLinks = doc.institutionLinks.filter((l) => l.fromId !== id && l.toId !== id);
    removeIdFromGroups(doc, id);
    Genogram.relationRules.clearAnchorReferences(doc, id);

    Genogram.relationRules.recomputeLayout(doc);
    Genogram.relationRules.recomputeInstitutionLayout(doc);
    cancelFamilyEdit();
    Genogram.app.refreshAll();
  }

  function setupFamilyForm() {
    const form = document.getElementById("family-form");
    form.addEventListener("submit", (evt) => {
      evt.preventDefault();
      const doc = Genogram.app.getDocument();

      const name = document.getElementById("family-name").value.trim();
      if (!name) return;

      const age = document.getElementById("family-age").value || null;
      const gender = mapGenderLabelToCode(document.getElementById("family-gender").value.trim());
      const relationToSubject = document.getElementById("family-relation").value.trim();
      const anchorPersonId = document.getElementById("family-anchor").value || null;
      const isCohabiting = document.getElementById("family-cohabiting").checked;
      const isDeceased = document.getElementById("family-deceased").checked;
      const isKeyPerson = document.getElementById("family-key-person").checked;
      const note = document.getElementById("family-note").value.trim();

      if (editingPersonId) {
        const person = doc.persons.find((p) => p.id === editingPersonId);
        if (!person) return;
        // 続柄（世代）か基準にする人が変わる時だけ自動レイアウトに戻す。それ以外の項目だけの
        // 変更で手動でドラッグした位置（他の人物・関係機関も含む）が消えてしまわないようにする
        const relationChanged =
          person.id !== doc.subjectId &&
          (person.relationToSubject !== relationToSubject || (person.anchorPersonId || "") !== (anchorPersonId || ""));
        person.name = name;
        person.age = age;
        person.gender = gender;
        if (person.id !== doc.subjectId) {
          person.relationToSubject = relationToSubject;
          person.anchorPersonId = anchorPersonId;
        }
        person.isCohabiting = isCohabiting;
        person.isDeceased = isDeceased;
        person.isKeyPerson = isKeyPerson;
        if (isKeyPerson) enforceSingleKeyPerson(doc, person.id);
        person.note = note;

        Genogram.relationRules.removeAutoRelationshipsForPerson(doc, person.id);
        Genogram.relationRules.buildMissingAutoRelationships(doc).forEach((r) => doc.relationships.push(r));
        if (relationChanged) {
          person.manuallyMoved = false;
          Genogram.relationRules.recomputeLayout(doc);
          Genogram.relationRules.recomputeInstitutionLayout(doc);
        }
        cancelFamilyEdit();
      } else {
        const pos = Genogram.relationRules.computeInitialPosition(doc, relationToSubject, anchorPersonId);
        const person = Genogram.createPerson({
          id: makeId("p"),
          name,
          age,
          gender,
          relationToSubject,
          anchorPersonId,
          isCohabiting,
          isDeceased,
          isKeyPerson,
          note,
          x: pos.x,
          y: pos.y,
        });
        doc.persons.push(person);
        if (isKeyPerson) enforceSingleKeyPerson(doc, person.id);
        Genogram.relationRules.buildMissingAutoRelationships(doc).forEach((r) => doc.relationships.push(r));
        Genogram.relationRules.recomputeLayout(doc);
        Genogram.relationRules.recomputeInstitutionLayout(doc);

        form.reset();
        document.getElementById("family-relation").value = "子";
        Genogram.app.refreshAll();
        // 新しく追加した人物が今の表示範囲の外にあると、追加されたことに気づきにくいため、
        // その場合だけ自動で全体表示に切り替える（既にちゃんと見えていれば視点は動かさない）
        if (!Genogram.canvas.isWorldPointVisible(person.x, person.y, 60)) {
          Genogram.canvas.fitToView(doc);
        }
        return;
      }

      Genogram.app.refreshAll();
    });

    document.getElementById("family-cancel-edit").addEventListener("click", cancelFamilyEdit);
    document.getElementById("family-delete-button").addEventListener("click", deleteCurrentPerson);
  }

  function renderFamilyList(doc) {
    const list = document.getElementById("family-list");
    list.innerHTML = "";
    doc.persons.forEach((person) => {
      const li = document.createElement("li");
      if (person.id === editingPersonId) li.classList.add("editing");
      const main = document.createElement("span");
      main.textContent = person.name;
      const sub = document.createElement("span");
      sub.className = "entity-sub";
      sub.textContent = personRelationLabel(doc, person);
      li.appendChild(main);
      li.appendChild(sub);
      li.addEventListener("click", () => startEditPerson(person));
      list.appendChild(li);
    });
    const editingPerson = editingPersonId ? doc.persons.find((p) => p.id === editingPersonId) : null;
    refreshAnchorSelect("family-anchor", doc, editingPersonId, editingPerson ? editingPerson.anchorPersonId : null);
  }

  // ===== 家族同士を手動でつなぐ =====
  // 自動生成される関係線（父母・配偶者・子・兄弟姉妹）以外にも、
  // 既に登録した人物同士を任意の関係種別でつなぎたい場合に使う。
  // ここで作る関係はisAuto:falseなので、樹形図のバー描画には取り込まれず、
  // 個別の線として描かれる。

  function refreshConnectPersonOptions() {
    const doc = Genogram.app.getDocument();
    const options = buildEntityOptions(doc, false);
    [document.getElementById("connect-person-a"), document.getElementById("connect-person-b")].forEach(
      (select, index) => {
        const previousValue = select.value;
        fillSelectWithEntities(select, options, previousValue);
        if (!previousValue && index === 1 && options.length > 1) {
          select.selectedIndex = 1; // 「誰を」は初期状態でAと別の人を選んでおく
        }
      }
    );
  }

  function setupConnectForm() {
    const form = document.getElementById("connect-form");
    form.addEventListener("submit", (evt) => {
      evt.preventDefault();
      const doc = Genogram.app.getDocument();
      const personAId = document.getElementById("connect-person-a").value;
      const personBId = document.getElementById("connect-person-b").value;
      const type = document.getElementById("connect-type").value;
      if (!personAId || !personBId || personAId === personBId) {
        alert("つなぐ相手には別の2人を選んでください。");
        return;
      }

      doc.relationships.push(
        Genogram.createRelationship({
          id: makeId("rel"),
          personAId,
          personBId,
          type,
          isAuto: false,
        })
      );
      Genogram.app.refreshAll();
    });
  }

  // ===== 関係機関（エコマップ側）=====

  function startEditInstitution(institution) {
    const doc = Genogram.app.getDocument();
    editingInstitutionId = institution.id;

    document.getElementById("institution-editing-id").value = institution.id;
    document.getElementById("institution-name").value = institution.name;
    document.getElementById("institution-category").value = institution.category;
    document.getElementById("institution-note").value = institution.note || "";

    document.getElementById("institution-submit-button").textContent = "✓ 更新する";
    document.getElementById("institution-cancel-edit").classList.remove("hidden");
    document.getElementById("institution-delete-button").classList.remove("hidden");

    activateTab("institution");
    renderInstitutionList(doc);
  }

  function cancelInstitutionEdit() {
    editingInstitutionId = null;
    const form = document.getElementById("institution-form");
    form.reset();
    document.getElementById("institution-editing-id").value = "";
    document.getElementById("institution-category").value = "医療";
    document.getElementById("institution-submit-button").textContent = "＋ 関係機関を追加";
    document.getElementById("institution-cancel-edit").classList.add("hidden");
    document.getElementById("institution-delete-button").classList.add("hidden");
    renderInstitutionList(Genogram.app.getDocument());
  }

  function deleteCurrentInstitution() {
    if (!editingInstitutionId) return;
    if (!window.confirm("この関係機関を削除しますか？")) return;

    const doc = Genogram.app.getDocument();
    const id = editingInstitutionId;
    doc.institutions = doc.institutions.filter((i) => i.id !== id);
    doc.institutionLinks = doc.institutionLinks.filter((l) => l.fromId !== id && l.toId !== id);
    removeIdFromGroups(doc, id);
    Genogram.relationRules.recomputeInstitutionLayout(doc);

    cancelInstitutionEdit();
    Genogram.app.refreshAll();
  }

  function setupInstitutionForm() {
    const form = document.getElementById("institution-form");
    form.addEventListener("submit", (evt) => {
      evt.preventDefault();
      const doc = Genogram.app.getDocument();

      const name = document.getElementById("institution-name").value.trim();
      if (!name) return;

      const category = document.getElementById("institution-category").value.trim();
      const note = document.getElementById("institution-note").value.trim();

      if (editingInstitutionId) {
        const institution = doc.institutions.find((i) => i.id === editingInstitutionId);
        if (!institution) return;
        institution.name = name;
        institution.category = category;
        institution.note = note;
        cancelInstitutionEdit();
      } else {
        const institution = Genogram.createInstitution({
          id: makeId("i"),
          name,
          category,
          note,
          x: 0,
          y: 0,
        });
        doc.institutions.push(institution);
        Genogram.relationRules.recomputeInstitutionLayout(doc);

        form.reset();
        document.getElementById("institution-category").value = "医療";
        Genogram.app.refreshAll();
        // 関係機関は家系図の下に弧を描くように配置されるため、今の表示範囲から
        // 外れて「追加したのに見えない」状態になりやすい。その場合だけ全体表示に切り替える
        if (!Genogram.canvas.isWorldPointVisible(institution.x, institution.y, 60)) {
          Genogram.canvas.fitToView(doc);
        }
        return;
      }

      Genogram.app.refreshAll();
    });

    document.getElementById("institution-cancel-edit").addEventListener("click", cancelInstitutionEdit);
    document.getElementById("institution-delete-button").addEventListener("click", deleteCurrentInstitution);
  }

  // ===== 関係機関をつなぐ（人物・機関のどちらも対象にできる）=====
  // 本人だけ・夫婦両方・子だけ・機関同士など、つながりの数だけ何度でも追加できる。
  // ここで作るリンクはisAuto:falseの個別線として描かれる。

  function refreshInstitutionConnectOptions() {
    const doc = Genogram.app.getDocument();
    const options = buildEntityOptions(doc, true);
    [document.getElementById("institution-connect-a"), document.getElementById("institution-connect-b")].forEach(
      (select, index) => {
        const previousValue = select.value;
        fillSelectWithEntities(select, options, previousValue);
        if (!previousValue && index === 1 && options.length > 1) {
          select.selectedIndex = 1;
        }
      }
    );
  }

  function setupInstitutionConnectForm() {
    const form = document.getElementById("institution-connect-form");
    form.addEventListener("submit", (evt) => {
      evt.preventDefault();
      const doc = Genogram.app.getDocument();
      const fromId = document.getElementById("institution-connect-a").value;
      const toId = document.getElementById("institution-connect-b").value;
      const type = document.getElementById("institution-connect-type").value;
      if (!fromId || !toId || fromId === toId) {
        alert("つなぐ相手には別の2つを選んでください。");
        return;
      }

      doc.institutionLinks.push(
        Genogram.createInstitutionLink({ id: makeId("link"), fromId, toId, type, isAuto: false })
      );
      Genogram.app.refreshAll();
    });
  }

  function renderInstitutionList(doc) {
    const list = document.getElementById("institution-list");
    list.innerHTML = "";
    doc.institutions.forEach((institution) => {
      const li = document.createElement("li");
      if (institution.id === editingInstitutionId) li.classList.add("editing");
      const main = document.createElement("span");
      main.textContent = institution.name;
      const sub = document.createElement("span");
      sub.className = "entity-sub";
      sub.textContent = institution.category;
      li.appendChild(main);
      li.appendChild(sub);
      li.addEventListener("click", () => startEditInstitution(institution));
      list.appendChild(li);
    });
  }

  // ===== グループ化（エコマップの任意の枠線）=====
  // 本人・家族・関係機関の中から好きな相手を選んでまとめ、点線の枠で囲う。
  // 枠線自体に関係線をつなぐこともできる（buildEntityOptionsにグループも含めているため）。

  function groupMemberCandidates(doc) {
    const people = doc.persons.map((p) => ({ id: p.id, label: `${p.name}（${p.relationToSubject}）` }));
    const institutions = doc.institutions.map((i) => ({ id: i.id, label: `${i.name}（機関）` }));
    return people.concat(institutions);
  }

  function renderGroupMemberCheckboxes(doc, selectedIds) {
    const container = document.getElementById("group-member-checkboxes");
    container.innerHTML = "";
    const selected = new Set(selectedIds || []);
    groupMemberCandidates(doc).forEach((candidate) => {
      const label = document.createElement("label");
      label.className = "checkbox-label";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = candidate.id;
      checkbox.checked = selected.has(candidate.id);
      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(candidate.label));
      container.appendChild(label);
    });
  }

  function getCheckedMemberIds() {
    return Array.from(document.querySelectorAll("#group-member-checkboxes input:checked")).map((el) => el.value);
  }

  function startEditGroup(group) {
    const doc = Genogram.app.getDocument();
    editingGroupId = group.id;

    document.getElementById("group-editing-id").value = group.id;
    document.getElementById("group-label").value = group.label;
    renderGroupMemberCheckboxes(doc, group.memberIds);

    document.getElementById("group-submit-button").textContent = "✓ 更新する";
    document.getElementById("group-cancel-edit").classList.remove("hidden");
    document.getElementById("group-delete-button").classList.remove("hidden");

    activateTab("group");
    renderGroupList(doc);
  }

  function cancelGroupEdit() {
    editingGroupId = null;
    const form = document.getElementById("group-form");
    form.reset();
    document.getElementById("group-editing-id").value = "";
    document.getElementById("group-submit-button").textContent = "＋ グループを作成";
    document.getElementById("group-cancel-edit").classList.add("hidden");
    document.getElementById("group-delete-button").classList.add("hidden");
    const doc = Genogram.app.getDocument();
    renderGroupMemberCheckboxes(doc, []);
    renderGroupList(doc);
  }

  function deleteCurrentGroup() {
    if (!editingGroupId) return;
    if (!window.confirm("このグループを削除しますか？枠線につながる関係線も削除されます。")) return;

    const doc = Genogram.app.getDocument();
    const id = editingGroupId;
    doc.groups = doc.groups.filter((g) => g.id !== id);
    doc.institutionLinks = doc.institutionLinks.filter((l) => l.fromId !== id && l.toId !== id);

    cancelGroupEdit();
    Genogram.app.refreshAll();
  }

  function setupGroupForm() {
    const form = document.getElementById("group-form");
    form.addEventListener("submit", (evt) => {
      evt.preventDefault();
      const doc = Genogram.app.getDocument();

      const label = document.getElementById("group-label").value.trim();
      if (!label) return;
      const memberIds = getCheckedMemberIds();
      if (memberIds.length === 0) {
        alert("メンバーを1人以上選んでください。");
        return;
      }

      if (editingGroupId) {
        const group = doc.groups.find((g) => g.id === editingGroupId);
        if (!group) return;
        group.label = label;
        group.memberIds = memberIds;
        cancelGroupEdit();
      } else {
        doc.groups.push(Genogram.createGroup({ id: makeId("grp"), label, memberIds }));
        form.reset();
        renderGroupMemberCheckboxes(doc, []);
      }

      Genogram.app.refreshAll();
    });

    document.getElementById("group-cancel-edit").addEventListener("click", cancelGroupEdit);
    document.getElementById("group-delete-button").addEventListener("click", deleteCurrentGroup);
  }

  // 編集中でない時だけメンバー候補一覧を最新化する（編集中に消すと選択状態が消えてしまうため）
  function refreshGroupMemberCheckboxesIfIdle() {
    if (editingGroupId) return;
    renderGroupMemberCheckboxes(Genogram.app.getDocument(), []);
  }

  function renderGroupList(doc) {
    const list = document.getElementById("group-list");
    list.innerHTML = "";
    (doc.groups || []).forEach((group) => {
      const li = document.createElement("li");
      if (group.id === editingGroupId) li.classList.add("editing");
      const main = document.createElement("span");
      main.textContent = group.label;
      const sub = document.createElement("span");
      sub.className = "entity-sub";
      sub.textContent = `${group.memberIds.length}人・機関`;
      li.appendChild(main);
      li.appendChild(sub);
      li.addEventListener("click", () => startEditGroup(group));
      list.appendChild(li);
    });
  }

  // ===== 図形クリックでその場編集できるポップアップ =====
  // サイドバーの「登録済み一覧（クリックで編集）」とは別の入口。クリックした
  // 座標にポップアップを出すことで、サイドバーまで目を移さずに編集できる。
  // 両方の入口が同時に開いて競合しないよう、図形クリック時はサイドバーへの
  // タブ切替・フォーム反映は行わない。

  let popupPersonId = null;
  let popupInstitutionId = null;

  function positionPopup(popup, clientX, clientY) {
    popup.style.left = "0px";
    popup.style.top = "0px";
    popup.classList.remove("hidden");
    const margin = 10;
    // タップした図形そのものがポップアップの真下に隠れてしまうと、同じ図形を
    // もう一度タップして閉じる操作（トグル）ができなくなるため、少し右下にずらす
    const shapeClearOffset = 24;
    const rect = popup.getBoundingClientRect();
    const left = Math.min(Math.max(margin, clientX + shapeClearOffset), window.innerWidth - rect.width - margin);
    const top = Math.min(Math.max(margin, clientY + shapeClearOffset), window.innerHeight - rect.height - margin);
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  }

  function closePersonPopup() {
    popupPersonId = null;
    document.getElementById("person-popup").classList.add("hidden");
  }

  function closeInstitutionPopup() {
    popupInstitutionId = null;
    document.getElementById("institution-popup").classList.add("hidden");
  }

  // ポップアップ内の「つなぐ相手」選択肢を、自分自身を除いた全人物・全関係機関で埋める。
  function refreshPopupLinkTarget(selectId, excludeId, doc) {
    const select = document.getElementById(selectId);
    const options = buildEntityOptions(doc, true).filter((opt) => opt.id !== excludeId);
    fillSelectWithEntities(select, options, null);
  }

  // ポップアップの「🔗つなぐ」ボタンから呼ばれる。相手が人物なら（自分も人物の場合）
  // 家族の手動接続と同じくdoc.relationshipsに、それ以外（機関が絡む場合）は
  // doc.institutionLinksに追加する。既存の手動接続フォームと同じ判定基準。
  function linkFromPopup(sourceId, targetId, type) {
    if (!targetId || targetId === sourceId) return;
    const doc = Genogram.app.getDocument();
    const sourceIsPerson = doc.persons.some((p) => p.id === sourceId);
    const targetIsPerson = doc.persons.some((p) => p.id === targetId);
    if (sourceIsPerson && targetIsPerson) {
      doc.relationships.push(
        Genogram.createRelationship({ id: makeId("rel"), personAId: sourceId, personBId: targetId, type, isAuto: false })
      );
    } else {
      doc.institutionLinks.push(
        Genogram.createInstitutionLink({ id: makeId("link"), fromId: sourceId, toId: targetId, type, isAuto: false })
      );
    }
    Genogram.app.refreshAll();
  }

  function openPersonPopup(person, clientX, clientY) {
    // 同じ人物をもう一度タップ/クリックしたら、開き直さずに閉じる（トグル動作）
    const alreadyOpenForThisPerson =
      popupPersonId === person.id && !document.getElementById("person-popup").classList.contains("hidden");
    if (alreadyOpenForThisPerson) {
      closePersonPopup();
      return;
    }
    closeInstitutionPopup();
    const doc = Genogram.app.getDocument();
    const isSubject = person.id === doc.subjectId;
    popupPersonId = person.id;

    document.getElementById("person-popup-name").value = person.name;
    document.getElementById("person-popup-age").value = person.age || "";
    document.getElementById("person-popup-gender").value = mapGenderCodeToLabel(person.gender);
    document.getElementById("person-popup-relation").value = person.relationToSubject;
    document.getElementById("person-popup-relation").disabled = isSubject;
    refreshAnchorSelect("person-popup-anchor", doc, person.id, person.anchorPersonId);
    document.getElementById("person-popup-anchor").disabled = isSubject;
    document.getElementById("person-popup-cohabiting").checked = person.isCohabiting;
    document.getElementById("person-popup-deceased").checked = person.isDeceased;
    document.getElementById("person-popup-key-person").checked = person.isKeyPerson;
    document.getElementById("person-popup-note").value = person.note || "";
    document.getElementById("person-popup-delete").classList.toggle("hidden", isSubject);
    document.getElementById("person-popup-duplicate").classList.toggle("hidden", isSubject);
    refreshPopupLinkTarget("person-popup-link-target", person.id, doc);

    positionPopup(document.getElementById("person-popup"), clientX, clientY);
  }

  function savePersonPopup() {
    const doc = Genogram.app.getDocument();
    const person = doc.persons.find((p) => p.id === popupPersonId);
    if (!person) return;
    const name = document.getElementById("person-popup-name").value.trim();
    if (!name) return;

    person.name = name;
    person.age = document.getElementById("person-popup-age").value || null;
    person.gender = mapGenderLabelToCode(document.getElementById("person-popup-gender").value.trim());
    let relationChanged = false;
    if (person.id !== doc.subjectId) {
      const newRelation = document.getElementById("person-popup-relation").value.trim();
      const newAnchorId = document.getElementById("person-popup-anchor").value || null;
      relationChanged =
        person.relationToSubject !== newRelation || (person.anchorPersonId || "") !== (newAnchorId || "");
      person.relationToSubject = newRelation;
      person.anchorPersonId = newAnchorId;
    }
    person.isCohabiting = document.getElementById("person-popup-cohabiting").checked;
    person.isDeceased = document.getElementById("person-popup-deceased").checked;
    person.isKeyPerson = document.getElementById("person-popup-key-person").checked;
    if (person.isKeyPerson) enforceSingleKeyPerson(doc, person.id);
    person.note = document.getElementById("person-popup-note").value.trim();

    Genogram.relationRules.removeAutoRelationshipsForPerson(doc, person.id);
    Genogram.relationRules.buildMissingAutoRelationships(doc).forEach((r) => doc.relationships.push(r));
    if (relationChanged) {
      person.manuallyMoved = false;
      Genogram.relationRules.recomputeLayout(doc);
      Genogram.relationRules.recomputeInstitutionLayout(doc);
    }
    closePersonPopup();
    Genogram.app.refreshAll();
  }

  function deletePersonPopup() {
    const doc = Genogram.app.getDocument();
    if (!popupPersonId || popupPersonId === doc.subjectId) return;
    if (!window.confirm("この家族を削除しますか？関連する関係線も削除されます。")) return;

    const id = popupPersonId;
    doc.persons = doc.persons.filter((p) => p.id !== id);
    doc.relationships = doc.relationships.filter((r) => r.personAId !== id && r.personBId !== id);
    doc.institutionLinks = doc.institutionLinks.filter((l) => l.fromId !== id && l.toId !== id);
    removeIdFromGroups(doc, id);
    Genogram.relationRules.clearAnchorReferences(doc, id);

    Genogram.relationRules.recomputeLayout(doc);
    Genogram.relationRules.recomputeInstitutionLayout(doc);
    closePersonPopup();
    Genogram.app.refreshAll();
  }

  // 名前の末尾に「（2）」「（3）」…をつけて、複製した人物を見分けやすくする。
  // すでに「（2）」付きの名前を複製した場合は元の名前から付け直し、次の空いている番号にする
  // （例：「孫テスト（2）」を複製→「孫テスト（3）」。「孫テスト（2）（3）」のようにはしない）。
  function nextDuplicateName(doc, originalName) {
    const baseName = originalName.replace(/（\d+）$/, "");
    let n = 2;
    while (doc.persons.some((p) => p.name === `${baseName}（${n}）`)) {
      n += 1;
    }
    return `${baseName}（${n}）`;
  }

  // 「同じ構成で複製」：性別・続柄・基準にする人・同居の有無・年齢・備考をそのまま引き継いだ
  // 人物をすぐ横に1人追加する。長男の子をもう1人追加する時など、似たような人物を1から
  // 入力し直す手間を減らすため。キーパーソンは1人だけの想定なので引き継がない。
  function duplicatePersonFromPopup() {
    const doc = Genogram.app.getDocument();
    const person = doc.persons.find((p) => p.id === popupPersonId);
    if (!person || person.id === doc.subjectId) return;

    const newPerson = Genogram.createPerson({
      id: makeId("p"),
      name: nextDuplicateName(doc, person.name),
      age: person.age,
      gender: person.gender,
      relationToSubject: person.relationToSubject,
      anchorPersonId: person.anchorPersonId,
      isCohabiting: person.isCohabiting,
      isDeceased: person.isDeceased,
      note: person.note,
      x: person.x,
      y: person.y,
    });
    doc.persons.push(newPerson);
    Genogram.relationRules.buildMissingAutoRelationships(doc).forEach((r) => doc.relationships.push(r));
    Genogram.relationRules.recomputeLayout(doc);
    Genogram.relationRules.recomputeInstitutionLayout(doc);

    closePersonPopup();
    Genogram.app.refreshAll();
    if (!Genogram.canvas.isWorldPointVisible(newPerson.x, newPerson.y, 60)) {
      Genogram.canvas.fitToView(doc);
    }
  }

  function openInstitutionPopup(institution, clientX, clientY) {
    // 同じ関係機関をもう一度タップ/クリックしたら、開き直さずに閉じる（トグル動作）
    const alreadyOpenForThisInstitution =
      popupInstitutionId === institution.id &&
      !document.getElementById("institution-popup").classList.contains("hidden");
    if (alreadyOpenForThisInstitution) {
      closeInstitutionPopup();
      return;
    }
    closePersonPopup();
    const doc = Genogram.app.getDocument();
    popupInstitutionId = institution.id;

    document.getElementById("institution-popup-name").value = institution.name;
    document.getElementById("institution-popup-category").value = institution.category;
    document.getElementById("institution-popup-note").value = institution.note || "";
    refreshPopupLinkTarget("institution-popup-link-target", institution.id, doc);

    positionPopup(document.getElementById("institution-popup"), clientX, clientY);
  }

  function saveInstitutionPopup() {
    const doc = Genogram.app.getDocument();
    const institution = doc.institutions.find((i) => i.id === popupInstitutionId);
    if (!institution) return;
    const name = document.getElementById("institution-popup-name").value.trim();
    if (!name) return;

    institution.name = name;
    institution.category = document.getElementById("institution-popup-category").value.trim();
    institution.note = document.getElementById("institution-popup-note").value.trim();
    closeInstitutionPopup();
    Genogram.app.refreshAll();
  }

  function deleteInstitutionPopup() {
    if (!popupInstitutionId) return;
    if (!window.confirm("この関係機関を削除しますか？")) return;

    const doc = Genogram.app.getDocument();
    const id = popupInstitutionId;
    doc.institutions = doc.institutions.filter((i) => i.id !== id);
    doc.institutionLinks = doc.institutionLinks.filter((l) => l.fromId !== id && l.toId !== id);
    removeIdFromGroups(doc, id);
    Genogram.relationRules.recomputeInstitutionLayout(doc);
    closeInstitutionPopup();
    Genogram.app.refreshAll();
  }

  function setupNodePopups() {
    document.getElementById("person-popup-save").addEventListener("click", savePersonPopup);
    document.getElementById("person-popup-duplicate").addEventListener("click", duplicatePersonFromPopup);
    document.getElementById("person-popup-delete").addEventListener("click", deletePersonPopup);
    document.getElementById("person-popup-close").addEventListener("click", closePersonPopup);
    document.getElementById("person-popup-close-x").addEventListener("click", closePersonPopup);
    document.getElementById("person-popup-link-button").addEventListener("click", () => {
      const targetId = document.getElementById("person-popup-link-target").value;
      const type = document.getElementById("person-popup-link-type").value;
      linkFromPopup(popupPersonId, targetId, type);
    });

    document.getElementById("institution-popup-save").addEventListener("click", saveInstitutionPopup);
    document.getElementById("institution-popup-delete").addEventListener("click", deleteInstitutionPopup);
    document.getElementById("institution-popup-close").addEventListener("click", closeInstitutionPopup);
    document.getElementById("institution-popup-close-x").addEventListener("click", closeInstitutionPopup);
    document.getElementById("institution-popup-link-button").addEventListener("click", () => {
      const targetId = document.getElementById("institution-popup-link-target").value;
      const type = document.getElementById("institution-popup-link-type").value;
      linkFromPopup(popupInstitutionId, targetId, type);
    });

    // ポップアップの外側を押したら閉じる。図形自身のクリックは専用の
    // 開閉ロジック（pointerup→onClick）に任せるため、ここでは無視する
    // （無視しないと「開いた直後のclickバブリングで即閉じる」バグになる）。
    // captureフェーズのpointerdownで判定することで、線や他の要素が
    // クリックイベントのbubbleを途中で止めて（stopPropagation）も、
    // それより先に確実に判定が走るようにしている。
    document.addEventListener(
      "pointerdown",
      (evt) => {
        if (evt.target.closest(".person-node, .institution-node")) return;
        const personPopup = document.getElementById("person-popup");
        const institutionPopup = document.getElementById("institution-popup");
        if (!personPopup.classList.contains("hidden") && !personPopup.contains(evt.target)) {
          closePersonPopup();
        }
        if (!institutionPopup.classList.contains("hidden") && !institutionPopup.contains(evt.target)) {
          closeInstitutionPopup();
        }
      },
      true
    );

    document.addEventListener("keydown", (evt) => {
      if (evt.key === "Escape") {
        closePersonPopup();
        closeInstitutionPopup();
      }
    });
  }

  Genogram.forms = {
    setup() {
      setupTabs();
      setupFamilyForm();
      setupInstitutionForm();
      setupConnectForm();
      setupInstitutionConnectForm();
      setupGroupForm();
      setupNodePopups();
    },
    refreshConnectPersonOptions,
    refreshInstitutionConnectOptions,
    renderConnectList,
    renderInstitutionConnectList,
    renderFamilyList,
    renderInstitutionList,
    renderGroupList,
    refreshGroupMemberCheckboxesIfIdle,
    startEditPerson,
    startEditInstitution,
    startEditGroup,
    focusAddForm,
    openPersonPopup,
    openInstitutionPopup,
    makeId,
  };
})(window.Genogram);
