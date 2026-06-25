// クリックで候補一覧がポップアップ表示される入力欄（コンボボックス）。
// <input list>+<datalist>は候補があることが見た目で分かりにくく、
// クリックしてもすぐに開かないブラウザもあるため、自前で実装している。
// 候補から選ぶことも、候補にない内容を直接タイプすることも両方できる。
// （Pythonアプリ側には無い、HTML版だけの部品）

(function (Genogram) {
  function setupComboBox(root) {
    const input = root.querySelector("input");
    const toggle = root.querySelector(".combo-toggle");
    const list = root.querySelector(".combo-list");
    if (!input || !toggle || !list) return;

    function openList() {
      list.classList.remove("hidden");
    }
    function closeList() {
      list.classList.add("hidden");
    }
    function isOpen() {
      return !list.classList.contains("hidden");
    }

    // 候補一覧は▾ボタンで開閉する。入力欄のfocusイベントでは開かない
    // （fill()のようなプログラム操作でもfocusが発生し、勝手に開いたままになるため）。
    toggle.addEventListener("click", (evt) => {
      evt.preventDefault();
      if (isOpen()) {
        closeList();
      } else {
        openList();
        input.focus();
      }
    });

    list.querySelectorAll("li").forEach((li) => {
      li.addEventListener("click", () => {
        input.value = li.textContent;
        closeList();
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
      });
    });

    document.addEventListener("click", (evt) => {
      if (!root.contains(evt.target)) closeList();
    });
  }

  function setupAll() {
    document.querySelectorAll(".combo-box").forEach(setupComboBox);
  }

  Genogram.comboBox = { setupAll };
})(window.Genogram);
