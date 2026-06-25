// 続柄から「関係線の自動生成」と「世代ごとの自動レイアウト」を行うルール。
// （Pythonのgenogram_app/relation_rules.pyと同じロジック＋世代レイアウトを追加）
//
// 続柄(relationToSubject)は常に「誰かを基準にした続柄」として解釈する。
// 基準にする人(anchorPersonId)を指定しなければ本人が基準になる（従来通り）。
// 例：子の配偶者を表すには、anchorPersonIdに対象の子のIDを入れてrelationToSubjectを"配偶者"にする。
// この仕組みにより、本人だけでなく子・兄弟など任意の人を基準にした続柄（孫、子の配偶者など）が
// 再帰的に何世代でも正しい位置・正しい関係線で表現できるようになる。

(function (Genogram) {
  const PARENT_RELATIONS = ["父", "母"];
  const SIBLING_RELATIONS = ["兄", "姉", "弟", "妹"];
  // 「子」の同義語。長男・次男などとそのまま入力しても「子」と同じ世代に配置される
  const CHILD_RELATIONS = ["子", "長男", "次男", "三男", "長女", "次女", "三女", "息子", "娘"];

  const LEVEL_Y_SPACING = 150; // 世代が1つ違うごとの縦の距離
  const ROW_X_SPACING = 130; // 同じ世代の人を横に並べるときの距離
  const BASE_X = 400;
  const BASE_Y = 300;

  // 続柄が表す関係の種類（親／子／配偶者・兄弟など同世代／その他）を判定する
  function relationClass(relationToSubject) {
    if (PARENT_RELATIONS.includes(relationToSubject)) return "parent";
    if (CHILD_RELATIONS.includes(relationToSubject)) return "child";
    if (relationToSubject === "配偶者") return "spouse";
    if (SIBLING_RELATIONS.includes(relationToSubject)) return "sibling";
    return "other";
  }

  // 基準人物から見た世代の差分（-1=親、+1=子、0=配偶者・兄弟・不明な続柄）。
  // "孫"は基準人物を指定しない簡易入力のための後方互換ショートカット（2世代下の段には
  // 置かれるが、「どの子の孫か」を表す関係線までは自動で引けない。正しく結婚線・兄弟バーまで
  // つなげたい場合は「基準にする人」で該当の子を選び、続柄を「子」にする方法を使う）。
  // 「祖父」「甥」など他の2世代以上離れた続柄は、基準を指定しないと本人と同じ世代に
  // 置かれる＝基準を選び忘れている合図として、あえて正しい位置にはしていない。
  function relationOffset(relationToSubject) {
    if (relationToSubject === "孫") return 2;
    const cls = relationClass(relationToSubject);
    if (cls === "parent") return -1;
    if (cls === "child") return 1;
    return 0;
  }

  // 同じ世代内での並び順（小さいほど左）。本人は父母と配偶者の間（兄姉の右）に来るよう2固定
  function localOrder(relationToSubject) {
    const table = { 父: 0, 母: 1, 兄: 0, 姉: 1, 本人: 2, 配偶者: 3, 弟: 4, 妹: 5 };
    if (table[relationToSubject] !== undefined) return table[relationToSubject];
    if (CHILD_RELATIONS.includes(relationToSubject)) return 10;
    return 50; // 自由入力の未知の続柄は右寄りに置く
  }

  // 続柄が「誰を基準にしているか」を返す。未指定なら本人が基準
  function resolveAnchorId(document, person) {
    return person.anchorPersonId || document.subjectId;
  }

  function findPerson(document, personId) {
    return document.persons.find((p) => p.id === personId);
  }

  // 基準人物をたどって世代を再帰的に求める（循環参照があっても無限ループしないようガードする）
  function computeGeneration(document, person, genCache, visiting) {
    if (person.id === document.subjectId) return 0;
    if (genCache.has(person.id)) return genCache.get(person.id);
    if (visiting.has(person.id)) return 0;
    visiting.add(person.id);
    const anchorId = resolveAnchorId(document, person);
    let anchorGen = 0;
    if (anchorId !== document.subjectId) {
      const anchorPerson = findPerson(document, anchorId);
      if (anchorPerson) anchorGen = computeGeneration(document, anchorPerson, genCache, visiting);
    }
    const gen = anchorGen + relationOffset(person.relationToSubject);
    genCache.set(person.id, gen);
    visiting.delete(person.id);
    return gen;
  }

  // 同一世代内での「枝」のまとまりを表すキー。子方向にたどるたびに1段深くなる配列で、
  // これを辞書順に並べると兄弟姉妹とその子孫がまとまって表示される（家系図らしい見た目になる）
  function computeBranchKey(document, person, keyCache, childIndexCache, visiting) {
    if (person.id === document.subjectId) return [];
    if (keyCache.has(person.id)) return keyCache.get(person.id);
    if (visiting.has(person.id)) return [0];
    visiting.add(person.id);
    const anchorId = resolveAnchorId(document, person);
    let parentKey = [];
    if (anchorId !== document.subjectId) {
      const anchorPerson = findPerson(document, anchorId);
      if (anchorPerson) parentKey = computeBranchKey(document, anchorPerson, keyCache, childIndexCache, visiting);
    }
    let key = parentKey;
    if (relationClass(person.relationToSubject) === "child") {
      if (!childIndexCache.has(anchorId)) {
        const siblingsUnderAnchor = document.persons
          .filter((p) => relationClass(p.relationToSubject) === "child" && resolveAnchorId(document, p) === anchorId)
          .map((p) => p.id);
        childIndexCache.set(anchorId, siblingsUnderAnchor);
      }
      const idx = childIndexCache.get(anchorId).indexOf(person.id);
      key = [...parentKey, idx < 0 ? 0 : idx];
    }
    keyCache.set(person.id, key);
    visiting.delete(person.id);
    return key;
  }

  function compareBranchKey(a, b) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const av = a[i] === undefined ? -1 : a[i];
      const bv = b[i] === undefined ? -1 : b[i];
      if (av !== bv) return av - bv;
    }
    return 0;
  }

  // 家族追加フォームの「続柄」入力欄から初期座標を求める。
  // 実際の最終位置はrecomputeLayoutで全員まとめて再計算されるため、
  // ここでは「とりあえず重ならない場所」を返すだけでよい。
  function computeInitialPosition(document, relationToSubject, anchorPersonId) {
    const anchorId = anchorPersonId || document.subjectId;
    const anchorPerson = findPerson(document, anchorId);
    const anchorGen =
      anchorId === document.subjectId
        ? 0
        : anchorPerson
        ? computeGeneration(document, anchorPerson, new Map(), new Set())
        : 0;
    const generation = anchorGen + relationOffset(relationToSubject);
    const existingInSameGeneration = document.persons.filter(
      (p) => computeGeneration(document, p, new Map(), new Set()) === generation
    ).length;
    return {
      x: BASE_X + existingInSameGeneration * ROW_X_SPACING,
      y: BASE_Y + generation * LEVEL_Y_SPACING,
    };
  }

  // 続柄・基準人物から世代・並び順を求めて、ドキュメント内の全員の座標を一括で
  // 再計算する。家族の追加・編集・削除のたびに呼び出すことで、
  // 常にジェノグラムらしい「世代ごとの横並び」を保つ。
  function recomputeLayout(document) {
    const genCache = new Map();
    const keyCache = new Map();
    const childIndexCache = new Map();

    // 「親子の単位」(computeFamilyUnits)を、親側ID・子側IDのどちらからでも
    // 引けるように索引化しておく（本人に近い世代から外側へ、隣の世代の確定済みの
    // 位置を基準に配置していくために使う）。
    const familyUnits = computeFamilyUnits(document);
    const unitsByParentId = new Map();
    const unitsByChildId = new Map();
    familyUnits.forEach((unit) => {
      unit.parentIds.forEach((id) => {
        if (!unitsByParentId.has(id)) unitsByParentId.set(id, []);
        unitsByParentId.get(id).push(unit);
      });
      unit.childIds.forEach((id) => {
        if (!unitsByChildId.has(id)) unitsByChildId.set(id, []);
        unitsByChildId.get(id).push(unit);
      });
    });

    // 「同じ行（横並びにすべき仲間）」をUnion-Findでまとめる。
    // 親子の単位の親同士・子同士、配偶者同士をまとめることで、「父母という夫婦」と
    // 「父とその兄弟（祖父の子達）」のように複数のつながりが1人(父)を介して重なっている
    // 場合でも、関係する全員を1つの行として正しく整列できる
    // （世代が違う者同士をまとめてしまっても、最終的な行は(世代, このID)の組で
    // 分けるため、世代がずれて混ざる心配は無い）。
    const ufParent = new Map();
    function ufFind(id) {
      if (!ufParent.has(id)) ufParent.set(id, id);
      let root = id;
      while (ufParent.get(root) !== root) root = ufParent.get(root);
      ufParent.set(id, root);
      return root;
    }
    function ufUnion(a, b) {
      const ra = ufFind(a);
      const rb = ufFind(b);
      if (ra !== rb) ufParent.set(ra, rb);
    }
    familyUnits.forEach((unit) => {
      unit.parentIds.forEach((id) => ufUnion(unit.parentIds[0], id));
      unit.childIds.forEach((id) => ufUnion(unit.childIds[0], id));
    });
    // 配偶者・兄弟姉妹・その他の続柄（親子以外）は、親の記録が無くても
    // 常に基準人物と同じ行にまとめる（familyUnitsは父母等の記録が無いと作られないため、
    // それだけに頼ると父母未登録の兄弟がバラバラの行に散ってしまう）。
    document.persons.forEach((person) => {
      const cls = relationClass(person.relationToSubject);
      if (cls === "spouse" || cls === "sibling" || cls === "other") {
        ufUnion(person.id, resolveAnchorId(document, person));
      }
    });

    // 各人物の(世代, 行クラスタ)を求めてグループ化する。
    // 配偶者（続柄＝"配偶者"）は続柄の文字列だけでは「誰の配偶者か」が分からず、
    // 兄弟それぞれの配偶者同士が登録順次第でバラバラに並んでしまい、結果として
    // 「兄の配偶者」「弟の配偶者」と「兄」「弟」が交差して、子供の位置もズレて見える
    // 不具合があった。配偶者は常に自分の基準人物（夫または妻）の並び順をそのまま借りて、
    // 基準人物のすぐ隣に来るようにする。
    function sortBasisFor(person) {
      if (relationClass(person.relationToSubject) !== "spouse") return person;
      const anchorPerson = findPerson(document, resolveAnchorId(document, person));
      return anchorPerson || person;
    }
    const insertionIndexOf = new Map();
    document.persons.forEach((p, i) => insertionIndexOf.set(p.id, i));

    const groupsByKey = new Map(); // key: `${generation}::${rowClusterId}`
    const allGenerations = new Set();
    document.persons.forEach((person) => {
      if (person.manuallyMoved) return; // 手動でドラッグした人物は自動レイアウトの対象から外す
      const generation = computeGeneration(document, person, genCache, new Set());
      const isSpouse = relationClass(person.relationToSubject) === "spouse";
      const sortBasis = sortBasisFor(person);
      const branchKey = computeBranchKey(document, sortBasis, keyCache, childIndexCache, new Set());
      const order = localOrder(sortBasis.relationToSubject);
      const insertionIndex = insertionIndexOf.get(sortBasis.id);
      const spouseFlag = isSpouse ? 1 : 0;
      const rowClusterId = ufFind(person.id);
      const key = `${generation}::${rowClusterId}`;
      if (!groupsByKey.has(key)) groupsByKey.set(key, { generation, rows: [] });
      groupsByKey.get(key).rows.push({ person, order, insertionIndex, branchKey, spouseFlag });
      allGenerations.add(generation);
    });

    // 本人の世代(0)から離れている順に処理する。これにより、ある世代の基準位置を
    // 求める時には「本人に近い側の隣接世代」が必ずもう確定済みになっており、
    // 古い座標を参照してしまう不整合が起きない（親世代は子達の確定位置の中央に、
    // 子世代は親達の確定位置の中央に、というジェノグラムの標準的な配置になる）。
    const orderedGenerations = Array.from(allGenerations).sort((a, b) => Math.abs(a) - Math.abs(b));

    // 各人物がどの(世代, 行クラスタ)グループに属するかを逆引きできるようにしておく
    const nodeKeyOf = new Map();
    groupsByKey.forEach((group, key) => {
      group.rows.forEach((row) => nodeKeyOf.set(row.person.id, key));
    });

    // ある人物の「外側（本人の世代0からより遠い側）」に直接つながる人物グループのキー一覧。
    // 世代0の人物は親側・子側どちらも外側になりうるため両方調べる。
    function outerNodeKeysFor(personId, generation) {
      const keys = new Set();
      function addFrom(units, neighborField) {
        (units || []).forEach((unit) => {
          unit[neighborField].forEach((neighborId) => {
            const key = nodeKeyOf.get(neighborId);
            if (key) keys.add(key);
          });
        });
      }
      if (generation <= 0) addFrom(unitsByChildId.get(personId), "parentIds"); // 自分が子の側＝親達はより外側(祖先側)
      if (generation >= 0) addFrom(unitsByParentId.get(personId), "childIds"); // 自分が親の側＝子達はより外側(子孫側)
      keys.delete(nodeKeyOf.get(personId));
      return Array.from(keys);
    }

    // 行の各メンバーの「専有幅」を求める。同じ外側グループ（例：本人と兄が同じ父母を
    // 共有している場合の「父母」グループ）は、行の中で最初に出てきたメンバー1人にのみ
    // 割り当てる（重複してメンバー全員に同じ幅を持たせると、必要以上に広がってしまうため）。
    function slotWidthsFor(rows, generation) {
      const claimedKeys = new Set();
      return rows.map(({ person }) => {
        const outerKeys = outerNodeKeysFor(person.id, generation).filter((k) => !claimedKeys.has(k));
        outerKeys.forEach((k) => claimedKeys.add(k));
        if (outerKeys.length === 0) return ROW_X_SPACING;
        return outerKeys.reduce((sum, k) => sum + Math.max(ROW_X_SPACING, computeRequiredWidth(k)), 0);
      });
    }

    // 「この人物グループを綺麗に並べるには、外側にぶら下がる祖先・子孫の枝も含めて
    // どれだけの横幅が必要か」を再帰的に求める（教科書的なジェノグラムは、家族が
    // 多い枝の下にはそのぶん広いスペースを確保し、隣の枝と重ならないようにする）。
    const widthCache = new Map();
    function computeRequiredWidth(nodeKey) {
      if (widthCache.has(nodeKey)) return widthCache.get(nodeKey);
      widthCache.set(nodeKey, ROW_X_SPACING); // 循環参照があった場合の保険
      const node = groupsByKey.get(nodeKey);
      const sortedRows = node.rows
        .slice()
        .sort(
          (a, b) =>
            compareBranchKey(a.branchKey, b.branchKey) || a.order - b.order || a.insertionIndex - b.insertionIndex || a.spouseFlag - b.spouseFlag
        );
      const total = slotWidthsFor(sortedRows, node.generation).reduce((sum, w) => sum + w, 0);
      const width = Math.max(total, ROW_X_SPACING);
      widthCache.set(nodeKey, width);
      return width;
    }

    // 未確定の世代・手動移動した人物のために、現在のx座標を「仮の参照値」として
    // 持っておく（無関係な枝など、隣接世代の情報が無い場合のフォールバックに使う）。
    const resolvedX = new Map();
    document.persons.forEach((p) => resolvedX.set(p.id, p.x));

    function referenceXFor(generation, rows) {
      if (generation === 0 && rows.some((row) => row.person.id === document.subjectId)) {
        return BASE_X; // 本人の行は常にBASE_X固定（全体の基準点）
      }
      const neighborXs = [];
      rows.forEach(({ person }) => {
        const relatedUnits = generation < 0 ? unitsByParentId.get(person.id) : unitsByChildId.get(person.id);
        (relatedUnits || []).forEach((unit) => {
          const neighborIds = generation < 0 ? unit.childIds : unit.parentIds;
          neighborIds.forEach((id) => {
            if (resolvedX.has(id)) neighborXs.push(resolvedX.get(id));
          });
        });
      });
      if (neighborXs.length > 0) return neighborXs.reduce((sum, x) => sum + x, 0) / neighborXs.length;
      // 隣接世代との接続が無い枝（無関係な別系統など）は、今の位置を基準にする
      const ownXs = rows.map((row) => resolvedX.get(row.person.id)).filter((x) => x !== undefined);
      return ownXs.length > 0 ? ownXs.reduce((sum, x) => sum + x, 0) / ownXs.length : BASE_X;
    }

    orderedGenerations.forEach((generation) => {
      groupsByKey.forEach((group, key) => {
        if (group.generation !== generation) return;
        const rows = group.rows;
        rows.sort(
          (a, b) =>
            compareBranchKey(a.branchKey, b.branchKey) || a.order - b.order || a.insertionIndex - b.insertionIndex || a.spouseFlag - b.spouseFlag
        );
        const centerX = referenceXFor(generation, rows);
        // 一律の間隔ではなく、各人物の外側にぶら下がる枝の幅に応じて自分の「専有幅」を
        // 確保してから横一列に並べる。これにより、隣り合う枝の祖先・子孫同士が
        // 重なり合わずに済む（教科書的なジェノグラムらしい整理になる）。
        const slotWidths = slotWidthsFor(rows, generation);
        const totalWidth = slotWidths.reduce((sum, w) => sum + w, 0);
        let cursor = centerX - totalWidth / 2;
        rows.forEach((row, indexInRow) => {
          const slot = slotWidths[indexInRow];
          const x = cursor + slot / 2;
          cursor += slot;
          row.person.x = x;
          row.person.y = BASE_Y + generation * LEVEL_Y_SPACING;
          resolvedX.set(row.person.id, x);
        });
      });
    });
  }

  // エコマップ側（関係機関）は、ジェノグラムの樹形図と重ならないよう
  // 一番下の世代よりさらに下に、扇状（アーク）に配置する。
  // 件数が増えるほど扇を広げ、本人を中心とした放射状の見た目に近づける。
  function recomputeInstitutionLayout(document) {
    const maxPersonY = document.persons.reduce((max, p) => Math.max(max, p.y), BASE_Y);
    const centerX = BASE_X;
    const centerY = maxPersonY + 170;
    const radius = 220;
    // 手動でドラッグした関係機関は自動の扇状配置から外す（位置を保持する）
    const autoInstitutions = document.institutions.filter((i) => !i.manuallyMoved);
    const total = autoInstitutions.length;
    const spreadDeg = Math.min(150, 40 + total * 18);
    const startDeg = total > 1 ? -spreadDeg / 2 : 0;
    const stepDeg = total > 1 ? spreadDeg / (total - 1) : 0;

    autoInstitutions.forEach((institution, index) => {
      const deg = startDeg + stepDeg * index;
      const rad = (deg * Math.PI) / 180;
      institution.x = centerX + radius * Math.sin(rad);
      institution.y = centerY + radius * Math.cos(rad);
    });
  }

  // 「整頓」ボタンなど、手動配置も含めて全員を自動レイアウトに戻したい時に呼ぶ。
  function resetManualPositions(document) {
    document.persons.forEach((p) => { p.manuallyMoved = false; });
    document.institutions.forEach((i) => { i.manuallyMoved = false; });
  }

  function pairKey(a, b) {
    return [a, b].sort().join("::");
  }

  // 指定したアンカーを基準にした「父母」役の人物一覧（基準人物自身の親）
  function parentsOfAnchor(document, anchorId) {
    return document.persons.filter(
      (p) => relationClass(p.relationToSubject) === "parent" && resolveAnchorId(document, p) === anchorId
    );
  }

  function spousesOfPerson(document, personId) {
    return document.persons
      .filter((p) => relationClass(p.relationToSubject) === "spouse" && resolveAnchorId(document, p) === personId)
      .map((p) => p.id);
  }

  // 「親子の単位（誰が誰の子か）」を関係グラフ全体から求める。
  // 続柄は「子を親基準で登録（基準にする人＝親、続柄＝子）」と
  // 「親を子基準で登録（基準にする人＝子、続柄＝父／母）」の2通りの入力方法があり、
  // 同じ親について両方の入力方法が混在すると、入力方法ごとに別々の単位として
  // 扱われてしまい、本来は兄弟であるはずの人同士がつながらずに見える不具合があった
  // （例：祖父を「父の父」として登録し、父の弟を「祖父の子」として登録すると、
  // 父と父の弟が別々の枝として表示されてしまう）。
  // これを防ぐため、親IDが1つでも重なる単位は同じ家族としてまとめる（Union-Find）。
  function computeFamilyUnits(document) {
    const candidates = []; // { childId, parentIds: Set }

    document.persons.forEach((person) => {
      if (relationClass(person.relationToSubject) !== "child") return;
      const anchorId = resolveAnchorId(document, person);
      candidates.push({ childId: person.id, parentIds: new Set([anchorId, ...spousesOfPerson(document, anchorId)]) });
    });

    const parentAnchorIds = new Set(
      document.persons
        .filter((p) => relationClass(p.relationToSubject) === "parent")
        .map((p) => resolveAnchorId(document, p))
    );
    parentAnchorIds.forEach((anchorId) => {
      const parentIds = new Set(parentsOfAnchor(document, anchorId).map((p) => p.id));
      if (parentIds.size === 0) return;
      candidates.push({ childId: anchorId, parentIds });
      document.persons
        .filter((p) => relationClass(p.relationToSubject) === "sibling" && resolveAnchorId(document, p) === anchorId)
        .forEach((sibling) => candidates.push({ childId: sibling.id, parentIds }));
    });

    // Union-Find：親IDを1つでも共有しているcandidate同士を同じグループにまとめる
    const parentIndex = candidates.map((_, i) => i);
    function find(i) {
      while (parentIndex[i] !== i) i = parentIndex[i];
      return i;
    }
    function union(i, j) {
      const ri = find(i);
      const rj = find(j);
      if (ri !== rj) parentIndex[ri] = rj;
    }
    const firstSeenAt = new Map(); // parentId -> candidatesのindex
    candidates.forEach((entry, i) => {
      entry.parentIds.forEach((pid) => {
        if (firstSeenAt.has(pid)) union(i, firstSeenAt.get(pid));
        else firstSeenAt.set(pid, i);
      });
    });

    const units = new Map(); // root -> { parentIds: Set, childIds: Set }
    candidates.forEach((entry, i) => {
      const root = find(i);
      if (!units.has(root)) units.set(root, { parentIds: new Set(), childIds: new Set() });
      const unit = units.get(root);
      entry.parentIds.forEach((id) => unit.parentIds.add(id));
      unit.childIds.add(entry.childId);
    });

    return Array.from(units.values()).map((u) => ({
      parentIds: Array.from(u.parentIds),
      childIds: Array.from(u.childIds),
    }));
  }

  function buildMissingAutoRelationships(document) {
    const subjectId = document.subjectId;
    const existingPairs = new Set(
      document.relationships.map((r) => pairKey(r.personAId, r.personBId))
    );
    const newRelationships = [];
    const severedPairs = new Set(document.severedRelationPairs || []);

    function anchorExists(anchorId) {
      return anchorId === subjectId || document.persons.some((p) => p.id === anchorId);
    }

    function addIfMissing(personAId, personBId, type) {
      const key = pairKey(personAId, personBId);
      if (existingPairs.has(key) || severedPairs.has(key)) return;
      existingPairs.add(key);
      newRelationships.push(
        Genogram.createRelationship({
          id: `auto_${personAId}_${personBId}`,
          personAId,
          personBId,
          type,
          isAuto: true,
        })
      );
    }

    // 各人物について「基準にした人物との関係」に応じた関係線を生成する。
    // 基準人物が本人の場合は従来通りの「本人から見た続柄」と同じ結果になる。
    document.persons.forEach((person) => {
      if (person.id === subjectId) return;
      const anchorId = resolveAnchorId(document, person);
      if (!anchorExists(anchorId)) return; // 基準人物が削除済みなら関係を作らない
      const cls = relationClass(person.relationToSubject);
      if (cls === "parent") {
        addIfMissing(person.id, anchorId, Genogram.RelationType.PARENT_CHILD);
      } else if (cls === "child") {
        addIfMissing(anchorId, person.id, Genogram.RelationType.PARENT_CHILD);
      } else if (cls === "spouse") {
        addIfMissing(anchorId, person.id, Genogram.RelationType.SPOUSE);
      } else if (cls === "sibling") {
        // 兄弟姉妹は基準人物と同じ親を持つ
        parentsOfAnchor(document, anchorId).forEach((parent) =>
          addIfMissing(parent.id, person.id, Genogram.RelationType.PARENT_CHILD)
        );
      }
    });

    // 父母同士にも配偶者線（結婚線）を自動で引く。これがないと樹形図の
    // 「結婚線→兄弟バー→各子」という標準構造の起点が作れない（本人の親だけでなく、
    // 子の親（＝子本人と子の配偶者）など、どのアンカーの親ペアにも同じ仕組みを適用する）
    const anchorIdsWithParents = new Set(
      document.persons
        .filter((p) => relationClass(p.relationToSubject) === "parent")
        .map((p) => resolveAnchorId(document, p))
    );
    anchorIdsWithParents.forEach((anchorId) => {
      const parents = parentsOfAnchor(document, anchorId);
      if (parents.length === 2) {
        addIfMissing(parents[0].id, parents[1].id, Genogram.RelationType.SPOUSE);
      }
    });

    return newRelationships;
  }

  // 標準的なジェノグラムの樹形図構造（親同士の結婚線→兄弟バー→各子への枝）を
  // 描くための「家族ユニット」を、関係グラフ全体から動的に抽出する。
  // 「配偶者ペア（または単独の親）→その子供達」の組をアンカーごとに束ねるため、
  // 本人を中心にした2ユニットだけでなく、子の配偶者・孫など何世代下でも同じ仕組みで
  // 結婚線＋兄弟バーが描画される。
  // 親から子への関係線が自動生成(isAuto)かつ親子関係(parent_child)のままの子だけを
  // バー描画の対象にする。手動で線種を変えた場合はその子は対象から外れ、
  // 通常の個別線として描かれる（=バーから外れて見える）。
  function buildFamilyTreeGroups(document) {
    const PARENT_CHILD = Genogram.RelationType.PARENT_CHILD;

    function relsFromParentsTo(parentIds, childId) {
      return document.relationships.filter(
        (r) => parentIds.includes(r.personAId) && r.personBId === childId
      );
    }

    function buildGroup(parentIds, candidateChildIds) {
      if (parentIds.length === 0) return null;
      const childIds = [];
      const childRelIds = {};
      candidateChildIds.forEach((childId) => {
        const rels = relsFromParentsTo(parentIds, childId);
        const eligible = rels.length > 0 && rels.every((r) => r.type === PARENT_CHILD && r.isAuto);
        if (eligible) {
          childIds.push(childId);
          childRelIds[childId] = rels.map((r) => r.id);
        }
      });
      if (childIds.length === 0) return null;
      return { parentIds, childIds, childRelIds };
    }

    const groups = [];
    computeFamilyUnits(document).forEach(({ parentIds, childIds }) => {
      const group = buildGroup(parentIds, childIds);
      if (group) groups.push(group);
    });
    return groups;
  }

  // 続柄や基準人物を変更すると世代が変わりうるため、関係線も一度作り直す。
  // 既存の自動関係線のうちpersonIdが関わるものは消して、buildMissingAutoRelationshipsで
  // 作り直せるようにする（手動で線種を変えたもの=isAuto:falseは保持する）。
  function removeAutoRelationshipsForPerson(document, personId) {
    document.relationships = document.relationships.filter(
      (r) => !(r.isAuto && (r.personAId === personId || r.personBId === personId))
    );
  }

  // 関係線を削除するときに使う。「いま存在する関係」を消すだけでなく、
  // このペアをdocument.severedRelationPairsに記録しておくことで、
  // 続柄的にはまだ自動生成の対象であっても二度と復活しないようにする
  // （削除したのに次の編集操作で勝手に復活する、というバグを防ぐため）。
  function markPairSevered(document, idA, idB) {
    if (!document.severedRelationPairs) document.severedRelationPairs = [];
    const key = pairKey(idA, idB);
    if (!document.severedRelationPairs.includes(key)) {
      document.severedRelationPairs.push(key);
    }
  }

  // 基準人物として参照していた人物が削除された場合に呼ぶ。基準人物を本人に戻す
  // （でないと、存在しないIDを基準にしたまま「どの世代にも正しく配置できない」状態になる）
  function clearAnchorReferences(document, deletedPersonId) {
    document.persons.forEach((p) => {
      if (p.anchorPersonId === deletedPersonId) p.anchorPersonId = null;
    });
  }

  Genogram.relationRules = {
    computeInitialPosition,
    recomputeLayout,
    recomputeInstitutionLayout,
    buildMissingAutoRelationships,
    removeAutoRelationshipsForPerson,
    markPairSevered,
    buildFamilyTreeGroups,
    resetManualPositions,
    resolveAnchorId,
    clearAnchorReferences,
  };
})(window.Genogram);
