const form = document.getElementById("login-form");
const errorBox = document.getElementById("error");
const submit = document.getElementById("submit");
const submitLabel = document.getElementById("submit-label");
const toggle = document.getElementById("toggle-pass");
const password = document.getElementById("password");
const hostLabel = document.getElementById("host-now");

if (hostLabel) hostLabel.textContent = location.host;

// Mostrar / ocultar contraseña
toggle?.addEventListener("click", () => {
  const show = password.type === "password";
  password.type = show ? "text" : "password";
  toggle.classList.toggle("on", show);
  toggle.setAttribute("aria-label", show ? "Ocultar contraseña" : "Mostrar contraseña");
  password.focus();
});

function setLoading(loading) {
  submit.disabled = loading;
  submit.classList.toggle("loading", loading);
  submitLabel.textContent = loading ? "Entrando…" : "Entrar";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.textContent = "";
  setLoading(true);

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
    setLoading(false);
    password.select?.();
  }
});
