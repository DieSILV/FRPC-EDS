const form = document.getElementById("login-form");
const errorBox = document.getElementById("error");
const submit = document.getElementById("submit");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.textContent = "";
  submit.disabled = true;
  submit.textContent = "Entrando…";

  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        user: form.user.value,
        password: form.password.value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "No se pudo iniciar sesión");
    location.href = "/";
  } catch (err) {
    errorBox.textContent = err.message;
    submit.disabled = false;
    submit.textContent = "Entrar";
  }
});
