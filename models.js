// ジェノグラム・エコマップのデータモデル定義。
// 保存・読込・画面描画は、すべてこの形のオブジェクトを介して行う。
// （Pythonのgenogram_app/models.pyと同じ構造）

window.Genogram = window.Genogram || {};

Genogram.Gender = {
  MALE: "male",     // 四角
  FEMALE: "female", // 丸
  UNKNOWN: "unknown", // ひし形
};

Genogram.RelationType = {
  SPOUSE: "spouse",
  PARENT_CHILD: "parent_child",
  NORMAL: "normal",
  STRONG: "strong",
  WEAK: "weak",
  CONFLICT: "conflict",
  WORKING: "working",
  WORKING_BOTH: "working_both",
};

Genogram.createPerson = function (overrides) {
  return Object.assign(
    {
      id: "",
      name: "",
      age: null,
      gender: Genogram.Gender.UNKNOWN,
      relationToSubject: "",
      // 続柄を「誰を基準にするか」。null=本人を基準（従来通り）。
      // 例：子の配偶者を表すには、anchorPersonIdに対象の子のIDを入れてrelationToSubjectを"配偶者"にする
      anchorPersonId: null,
      // 続柄が「子」系の時だけ使う。基準にする人（anchorPersonId）に配偶者が複数いる
      // （離婚・再婚など）場合、どちらの配偶者との間の子かを明示するためのID。
      // null＝基準にする人の配偶者が1人以下（従来通り自動判定）
      secondParentId: null,
      isCohabiting: false,
      isDeceased: false,
      isKeyPerson: false, // キーパーソン（主たる介護者・連絡先）。1ドキュメントにつき基本1人を想定
      manuallyMoved: false, // ドラッグで手動配置したらtrue。recomputeLayoutの対象から外れる
      x: 0,
      y: 0,
      note: "",
    },
    overrides
  );
};

Genogram.createRelationship = function (overrides) {
  return Object.assign(
    {
      id: "",
      personAId: "",
      personBId: "",
      type: Genogram.RelationType.NORMAL,
      isAuto: false,
      // 配偶者関係(type:spouse)の時だけ意味を持つ。null=婚姻中（マークなし）/"separated"=別居/"divorced"=離婚
      maritalStatus: null,
    },
    overrides
  );
};

Genogram.createInstitution = function (overrides) {
  return Object.assign(
    {
      id: "",
      name: "",
      category: "",
      manuallyMoved: false, // ドラッグで手動配置したらtrue。recomputeInstitutionLayoutの対象から外れる
      x: 0,
      y: 0,
      note: "",
    },
    overrides
  );
};

// 関係機関どうし・関係機関と人物・人物と人物（エコマップ的な関係性）を結ぶ線。
// fromId/toIdは人物ID・関係機関ID・グループIDのいずれでもよい（getNodeCenterが全て探す）。
Genogram.createInstitutionLink = function (overrides) {
  return Object.assign(
    {
      id: "",
      fromId: "",
      toId: "",
      type: Genogram.RelationType.NORMAL,
      isAuto: false,
    },
    overrides
  );
};

// エコマップで「拡大家族」「職場」など任意の人物・関係機関をまとめて
// 枠線で囲うためのグループ。枠線自体をinstitutionLinkのfromId/toIdに
// 指定して、グループ全体に対する関係線を引くこともできる。
Genogram.createGroup = function (overrides) {
  return Object.assign(
    {
      id: "",
      label: "",
      memberIds: [],
      // 枠線の輪郭を手動でドラッグ変形した分（重心から12方向に伸ばした半径の増減）。
      // 各要素は自動計算した半径からのズレ(px)で、空配列・未設定=自動計算のまま
      boundaryShape: [],
    },
    overrides
  );
};

Genogram.createDocument = function (overrides) {
  return Object.assign(
    {
      formatVersion: 1,
      subjectId: "",
      persons: [],
      relationships: [],
      institutions: [],
      institutionLinks: [],
      groups: [],
      overallNote: "",
      // 同居家族の囲みを手動でドラッグ移動した分のオフセット{dx,dy}（null=自動計算のまま）
      cohabitingBoundaryOverride: null,
      // 同居家族の囲みの輪郭を手動でドラッグ変形した分（boundaryShapeと同じ仕組み）
      cohabitingBoundaryShape: [],
      // 一度削除した関係のペア（"id1::id2"の形）。自動生成ルールが復活させないようにする
      severedRelationPairs: [],
      // 端末への自動保存で複数のジェノグラムを区別するためのID（null=未割り当て）
      caseId: null,
      // 「保存データ一覧」で見分けやすくするためのメモ（例：「研修用」「事例検討用」）
      caseLabel: "",
      // PDF出力のヘッダーに表示する作成者名（任意入力、一度入れれば次回も引き継がれる）
      creatorName: "",
    },
    overrides
  );
};
