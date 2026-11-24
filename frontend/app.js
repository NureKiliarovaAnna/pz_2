// DAO voting dApp: MetaMask, network check, state, transactions, events.
(function () {
  const { ethers } = window;
  const CONFIG = window.DAO_CONFIG;
  const { explain, STATE_NAMES } = window.DAOErrors;

  const PAGE_SIZE = 5;
  const LOCAL_RPC = "http://127.0.0.1:8545";
  const ROLE = {
    ADMIN: ethers.ZeroHash,
    PROPOSER: ethers.id("PROPOSER_ROLE"),
    GUARDIAN: ethers.id("GUARDIAN_ROLE"),
  };
  const CHAIN_PARAMS = {
    31337: {
      chainId: "0x7a69",
      chainName: "Hardhat Localhost",
      rpcUrls: [LOCAL_RPC],
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    },
    11155111: { chainId: "0xaa36a7" },
  };

  const $ = (id) => document.getElementById(id);
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
  const eth = (v) => `${Number(ethers.formatEther(v)).toLocaleString("uk-UA", { maximumFractionDigits: 6 })} ETH`;
  const dvt = (v) => `${Number(ethers.formatEther(v)).toLocaleString("uk-UA", { maximumFractionDigits: 4 })} DVT`;

  const app = {
    provider: null,
    signer: null,
    account: null,
    chainId: null,
    contracts: null,
    page: 0,
    proposalCount: 0n,
    chainTime: 0,
    chainTimeFetchedAt: 0,
    roles: { admin: false, proposer: false, guardian: false },
    refreshTimer: null,
  };

  if (!CONFIG) {
    $("intro").innerHTML =
      "<p>Не знайдено <code>config.js</code>. Спершу розгорніть контракти: " +
      "<code>npm run deploy:local</code>.</p>";
    $("connectBtn").disabled = true;
    return;
  }

  window.DAOErrors.init(CONFIG.abis);

  /* ------------------------------ UI helpers ------------------------------ */

  let toastTimer;
  function toast(message, kind = "") {
    const el = $("toast");
    el.textContent = message;
    el.className = `toast ${kind}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 6000);
  }

  function addLog(listId, html, cls = "") {
    const li = document.createElement("li");
    li.className = cls;
    li.innerHTML = html;
    const list = $(listId);
    list.prepend(li);
    while (list.children.length > 40) list.lastChild.remove();
    return li;
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  function explorerTx(hash) {
    return app.chainId === 11155111
      ? `<a href="https://sepolia.etherscan.io/tx/${hash}" target="_blank" rel="noopener">${short(hash)}</a>`
      : `<span class="mono">${short(hash)}</span>`;
  }

  function nowOnChain() {
    if (!app.chainTime) return Math.floor(Date.now() / 1000);
    return app.chainTime + Math.floor((Date.now() - app.chainTimeFetchedAt) / 1000);
  }

  function formatDuration(seconds) {
    if (seconds <= 0) return "завершено";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h > 0 ? `${h} год ${m} хв` : m > 0 ? `${m} хв ${s} с` : `${s} с`;
  }

  /* ----------------------------- Transactions ----------------------------- */

  /// Sends a transaction and tracks it: pending -> confirmed / error.
  async function sendTx(label, buildTx) {
    const li = addLog(
      "txList",
      `<span class="status">Підпис…</span> ${escapeHtml(label)}`,
      "pending"
    );
    const setStatus = (status, cls, extra = "") => {
      li.className = cls;
      li.innerHTML = `<span class="status">${status}</span> ${escapeHtml(label)}${extra}`;
    };

    try {
      const tx = await buildTx();
      setStatus("Очікує підтвердження", "pending", ` — ${explorerTx(tx.hash)}`);
      toast(`«${label}» надіслано, очікуємо підтвердження…`);

      const receipt = await tx.wait();
      setStatus(
        "Підтверджено",
        "confirmed",
        ` — блок ${receipt.blockNumber}, газ ${receipt.gasUsed} — ${explorerTx(tx.hash)}`
      );
      toast(`«${label}» підтверджено.`, "ok");
      await refresh();
      return receipt;
    } catch (error) {
      const message = explain(error);
      setStatus("Помилка", "failed", ` — ${escapeHtml(message)}`);
      toast(message, "error");
      console.error(label, error);
      return null;
    }
  }

  /* ------------------------------ Connection ------------------------------ */

  async function connect() {
    if (!window.ethereum) {
      toast("MetaMask не знайдено. Встановіть розширення MetaMask.", "error");
      return;
    }

    try {
      app.provider = new ethers.BrowserProvider(window.ethereum, "any");
      await app.provider.send("eth_requestAccounts", []);
      await setup();
    } catch (error) {
      toast(explain(error), "error");
    }
  }

  async function setup() {
    stopListeners();

    app.provider = new ethers.BrowserProvider(window.ethereum, "any");
    const accounts = await app.provider.send("eth_accounts", []);
    if (accounts.length === 0) {
      showDisconnected();
      return;
    }

    app.signer = await app.provider.getSigner();
    app.account = ethers.getAddress(accounts[0]);
    app.chainId = Number((await app.provider.getNetwork()).chainId);

    $("accountBadge").textContent = short(app.account);
    $("accountBadge").title = app.account;
    $("connectBtn").textContent = "Підключено";
    $("connectBtn").disabled = true;

    const deployment = CONFIG.networks[app.chainId];
    const supported = Object.entries(CONFIG.networks)
      .map(([id, n]) => `${n.name} (${id})`)
      .join(", ");

    if (!deployment) {
      $("networkBadge").textContent = `Мережа: ${app.chainId}`;
      $("networkBadge").className = "badge bad";
      $("networkWarningText").textContent =
        `Неправильна мережа (chainId ${app.chainId}). Контракти розгорнуто в: ${supported}.`;
      $("networkWarning").hidden = false;
      $("app").hidden = true;
      $("intro").hidden = false;
      return;
    }

    $("networkWarning").hidden = true;
    $("networkBadge").textContent = `Мережа: ${deployment.name}`;
    $("networkBadge").className = "badge ok";
    $("devTools").hidden = app.chainId !== 31337;
    $("intro").hidden = true;
    $("app").hidden = false;

    const a = deployment.addresses;
    app.contracts = {
      token: new ethers.Contract(a.DAOToken, CONFIG.abis.DAOToken, app.signer),
      treasury: new ethers.Contract(a.DAOTreasury, CONFIG.abis.DAOTreasury, app.signer),
      governor: new ethers.Contract(a.DAOGovernor, CONFIG.abis.DAOGovernor, app.signer),
    };

    const code = await app.provider.getCode(a.DAOGovernor);
    if (code === "0x") {
      $("networkWarningText").textContent =
        "За адресою з config.js немає контракту. Мережу перезапущено? Розгорніть контракти знову.";
      $("networkWarning").hidden = false;
      return;
    }

    startListeners();
    await refresh();
  }

  function showDisconnected() {
    app.account = null;
    $("accountBadge").textContent = "Гаманець не підключено";
    $("connectBtn").textContent = "Підключити MetaMask";
    $("connectBtn").disabled = false;
    $("app").hidden = true;
    $("intro").hidden = false;
  }

  async function switchNetwork() {
    const target = CONFIG.defaultChainId;
    const params = CHAIN_PARAMS[target] || { chainId: ethers.toQuantity(target) };
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: params.chainId }],
      });
    } catch (error) {
      if (error.code === 4902 && params.rpcUrls) {
        await window.ethereum.request({ method: "wallet_addEthereumChain", params: [params] });
      } else {
        toast(explain(error), "error");
      }
    }
  }

  /* -------------------------------- Events -------------------------------- */

  const EVENT_TEXT = {
    ProposalCreated: (a) => `Створено пропозицію #${a[0]}: ${eth(a[3])} → ${short(a[2])}`,
    VoteCast: (a) => `${short(a[1])} проголосував(-ла) «${["проти", "за", "утримався"][Number(a[2])]}» за #${a[0]} вагою ${dvt(a[3])}`,
    ProposalExecuted: (a) => `Пропозицію #${a[0]} виконано, зарезервовано ${eth(a[3])}`,
    PayoutReserved: (a) => `Скарбниця: резерв ${eth(a[2])} для ${short(a[1])} (#${a[0]})`,
    Withdrawn: (a) => `Скарбниця: ${short(a[0])} отримав(-ла) ${eth(a[1])}`,
    Deposited: (a) => `Скарбниця: поповнення ${eth(a[1])} від ${short(a[0])}`,
    Paused: (a) => `Пауза увімкнена (${short(a[0])})`,
    Unpaused: (a) => `Пауза знята (${short(a[0])})`,
    DelegateChanged: (a) => `${short(a[0])} делегує голоси ${short(a[2])}`,
    GovernorSet: (a) => `Скарбницю прив'язано до ${short(a[0])}`,
  };

  function startListeners() {
    const { token, treasury, governor } = app.contracts;
    const sources = [
      [governor, "Governor", ["ProposalCreated", "VoteCast", "ProposalExecuted", "Paused", "Unpaused"]],
      [treasury, "Treasury", ["PayoutReserved", "Withdrawn", "Deposited", "Paused", "Unpaused", "GovernorSet"]],
      [token, "Token", ["DelegateChanged"]],
    ];

    for (const [contract, label, names] of sources) {
      for (const name of names) {
        contract.on(name, (...args) => {
          const event = args[args.length - 1];
          const text = EVENT_TEXT[name] ? EVENT_TEXT[name](args) : name;
          addLog(
            "eventList",
            `<strong>${label}.${name}</strong> — ${escapeHtml(text)} ` +
              `<span class="muted">(блок ${event.log.blockNumber})</span>`
          );
          scheduleRefresh();
        });
      }
    }

    app.provider.on("block", scheduleRefresh);
  }

  function stopListeners() {
    if (!app.contracts) return;
    for (const c of Object.values(app.contracts)) c.removeAllListeners();
    app.provider?.removeAllListeners("block");
  }

  function scheduleRefresh() {
    clearTimeout(app.refreshTimer);
    app.refreshTimer = setTimeout(refresh, 300);
  }

  /* ------------------------------ Reading state ---------------------------- */

  async function refresh() {
    if (!app.contracts) return;
    const { token, treasury, governor } = app.contracts;
    const me = app.account;

    try {
      const [
        balance, votes, delegatee, treasuryBalance, available, reserved, claimable,
        govPaused, treasuryPaused, isAdmin, isProposer, isGuardian,
        isTreasuryAdmin, isTreasuryGuardian, votingPeriod, count, block,
      ] = await Promise.all([
        token.balanceOf(me),
        token.getVotes(me),
        token.delegates(me),
        app.provider.getBalance(treasury.target),
        treasury.availableBalance(),
        treasury.totalReserved(),
        treasury.claimable(me),
        governor.paused(),
        treasury.paused(),
        governor.hasRole(ROLE.ADMIN, me),
        governor.hasRole(ROLE.PROPOSER, me),
        governor.hasRole(ROLE.GUARDIAN, me),
        treasury.hasRole(ROLE.ADMIN, me),
        treasury.hasRole(ROLE.GUARDIAN, me),
        governor.votingPeriod(),
        governor.proposalCount(),
        app.provider.getBlock("latest"),
      ]);

      app.chainTime = Number(block.timestamp);
      app.chainTimeFetchedAt = Date.now();
      app.proposalCount = count;
      app.roles = {
        admin: isAdmin, proposer: isProposer, guardian: isGuardian,
        treasuryAdmin: isTreasuryAdmin, treasuryGuardian: isTreasuryGuardian,
      };

      $("tokenBalance").textContent = dvt(balance);
      $("votingPower").textContent = dvt(votes);
      $("delegatee").textContent =
        delegatee === ethers.ZeroAddress ? "не делеговано"
          : delegatee === me ? "собі" : short(delegatee);

      const roles = [
        (isAdmin || isTreasuryAdmin) && "ADMIN",
        isProposer && "PROPOSER",
        (isGuardian || isTreasuryGuardian) && "GUARDIAN",
      ].filter(Boolean);
      $("roles").textContent = roles.length ? roles.join(", ") : "голосуючий";

      $("treasuryBalance").textContent = eth(treasuryBalance);
      $("treasuryAvailable").textContent = eth(available);
      $("treasuryReserved").textContent = eth(reserved);
      $("claimable").textContent = eth(claimable);
      $("withdrawBtn").disabled = claimable === 0n || treasuryPaused;

      $("treasuryPaused").hidden = !treasuryPaused;
      $("governorStatus").textContent = govPaused ? "⏸ на паузі" : "працює";
      $("treasuryStatus").textContent = treasuryPaused ? "⏸ на паузі" : "працює";
      $("votingPeriod").textContent = formatDuration(Number(votingPeriod));

      document.querySelectorAll('[data-action="pause"]').forEach((b) => {
        const t = b.dataset.target;
        const paused = t === "governor" ? govPaused : treasuryPaused;
        const allowed = t === "governor" ? isGuardian : isTreasuryGuardian;
        b.disabled = paused || !allowed;
        b.title = allowed ? "" : "Потрібна роль GUARDIAN";
      });
      document.querySelectorAll('[data-action="unpause"]').forEach((b) => {
        const t = b.dataset.target;
        const paused = t === "governor" ? govPaused : treasuryPaused;
        const allowed = t === "governor" ? isAdmin : isTreasuryAdmin;
        b.disabled = !paused || !allowed;
        b.title = allowed ? "" : "Потрібна роль ADMIN";
      });

      const proposeDisabled = !isProposer || govPaused;
      document.querySelectorAll("#proposalForm input, #proposalForm textarea, #proposalForm button")
        .forEach((el) => (el.disabled = proposeDisabled ||
          (el.type === "submit" && busyForms.has("proposalForm"))));
      $("proposerHint").textContent = !isProposer
        ? "Створювати пропозиції може лише акаунт з роллю PROPOSER."
        : govPaused ? "Governor на паузі." : "";

      await renderProposals(govPaused);
    } catch (error) {
      console.error(error);
      toast(`Не вдалося прочитати стан: ${explain(error)}`, "error");
    }
  }

  async function renderProposals(govPaused) {
    const { governor } = app.contracts;
    const total = Number(app.proposalCount);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    app.page = Math.min(app.page, pages - 1);

    $("proposalTotal").textContent = `(${total})`;
    $("pageInfo").textContent = `${app.page + 1} / ${pages}`;
    $("prevPage").disabled = app.page === 0;
    $("nextPage").disabled = app.page >= pages - 1;

    const container = $("proposals");
    if (total === 0) {
      container.innerHTML = '<div class="empty">Пропозицій ще немає.</div>';
      return;
    }

    // Newest first: page 0 shows the last PAGE_SIZE proposals.
    const end = total - app.page * PAGE_SIZE;
    const offset = Math.max(0, end - PAGE_SIZE);
    const limit = end - offset;
    const items = await governor.getProposals(offset, limit);

    const rows = await Promise.all(
      items.map(async (p, i) => {
        const id = BigInt(offset + i + 1);
        const [state, voted, quorum] = await Promise.all([
          governor.state(id),
          governor.hasVoted(id, app.account),
          governor.quorum(id).catch(() => null),
        ]);
        return { id, p, state: Number(state), voted, quorum };
      })
    );

    rows.reverse();
    container.innerHTML = rows.map((r) => proposalHtml(r, govPaused)).join("");
  }

  function proposalHtml({ id, p, state, voted, quorum }, govPaused) {
    const total = p.forVotes + p.againstVotes + p.abstainVotes;
    const scale = quorum && quorum > total ? quorum : total || 1n;
    const pct = (v) => Number((v * 10000n) / scale) / 100;
    const left = Number(p.deadline) - nowOnChain();

    const canVote = state === 1 && !voted && !govPaused;
    const canExecute = state === 3 && !govPaused;

    const bar = (label, value, cls) => `
      <div class="bar">
        <span>${label}</span>
        <div class="bar-track"><div class="bar-fill ${cls}" style="width:${pct(value)}%"></div></div>
        <span>${dvt(value)}</span>
      </div>`;

    return `
      <article class="proposal">
        <div class="proposal-head">
          <span class="proposal-title">#${id} — ${escapeHtml(p.description)}</span>
          <span class="tag state-${state}">${STATE_NAMES[state]}</span>
        </div>
        <div class="proposal-meta">
          <span>Сума: <strong>${eth(p.amount)}</strong></span>
          <span>Отримувач: <span class="mono" title="${p.recipient}">${short(p.recipient)}</span></span>
          <span>Автор: <span class="mono" title="${p.proposer}">${short(p.proposer)}</span></span>
          <span>Знімок: блок ${p.snapshotBlock}</span>
          <span>Дедлайн: ${new Date(Number(p.deadline) * 1000).toLocaleString("uk-UA")}
            ${state <= 1 ? `(${formatDuration(left)})` : ""}</span>
        </div>
        <div class="bars">
          ${bar("За", p.forVotes, "for")}
          ${bar("Проти", p.againstVotes, "against")}
          ${bar("Утримались", p.abstainVotes, "abstain")}
          ${quorum !== null ? bar("Кворум", quorum, "quorum") : '<div class="muted">Кворум буде відомий після блоку знімка</div>'}
        </div>
        <div class="row wrap">
          <button data-vote="1" data-id="${id}" ${canVote ? "" : "disabled"}>За</button>
          <button data-vote="0" data-id="${id}" ${canVote ? "" : "disabled"}>Проти</button>
          <button data-vote="2" data-id="${id}" ${canVote ? "" : "disabled"}>Утриматись</button>
          <button class="primary" data-execute="${id}" ${canExecute ? "" : "disabled"}>Виконати</button>
          ${voted ? '<span class="muted">Ви вже проголосували</span>' : ""}
        </div>
      </article>`;
  }

  /* -------------------------------- Actions ------------------------------- */

  function parseEthInput(value) {
    const text = String(value).trim().replace(",", ".");
    if (!text || Number(text) <= 0) throw new Error("Введіть суму більшу за нуль.");
    return ethers.parseEther(text);
  }

  function parseAddressInput(value) {
    const text = String(value).trim();
    if (!ethers.isAddress(text)) throw new Error("Некоректна адреса Ethereum.");
    return ethers.getAddress(text);
  }

  function guard(fn) {
    return async (event) => {
      // Only cancel the page reload of a form submit. Cancelling every click
      // (this guard also wraps the document click handler) would cancel the
      // submit buttons' default action, so forms would never be submitted.
      if (event?.type === "submit") event.preventDefault();
      try {
        await fn(event);
      } catch (error) {
        console.error(error);
        toast(error.message && !error.code ? error.message : explain(error), "error");
      }
    };
  }

  /// Submit handler that blocks repeated sending while a transaction is in flight.
  const busyForms = new Set();
  function onSubmit(formId, fn) {
    const form = $(formId);
    form.addEventListener("submit", guard(async () => {
      if (busyForms.has(formId)) {
        toast("Попередня транзакція ще обробляється. Зачекайте.", "error");
        return;
      }
      if (!app.contracts) throw new Error("Спершу підключіть MetaMask у правильній мережі.");
      busyForms.add(formId);
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        await fn();
      } finally {
        busyForms.delete(formId);
        button.disabled = false;
        refresh();
      }
    }));
  }

  $("connectBtn").addEventListener("click", connect);
  $("switchNetworkBtn").addEventListener("click", switchNetwork);

  $("prevPage").addEventListener("click", () => { app.page--; refresh(); });
  $("nextPage").addEventListener("click", () => { app.page++; refresh(); });

  $("propDescription").addEventListener("input", (e) => {
    const bytes = new TextEncoder().encode(e.target.value).length;
    $("descCounter").textContent = `${bytes} / 512 байтів`;
    $("descCounter").style.color = bytes > 512 ? "var(--danger)" : "";
  });

  onSubmit("proposalForm", async () => {
    const recipient = parseAddressInput($("propRecipient").value);
    const amount = parseEthInput($("propAmount").value);
    const description = $("propDescription").value.trim();
    if (!description) throw new Error("Опис пропозиції не може бути порожнім.");
    const receipt = await sendTx(`Створення пропозиції (${ethers.formatEther(amount)} ETH)`, () =>
      app.contracts.governor.createProposal(recipient, amount, description)
    );
    if (receipt) $("proposalForm").reset();
  });

  onSubmit("depositForm", async () => {
    const value = parseEthInput($("depositAmount").value);
    const receipt = await sendTx(`Поповнення скарбниці на ${ethers.formatEther(value)} ETH`, () =>
      app.contracts.treasury.deposit({ value })
    );
    if (receipt) $("depositForm").reset();
  });

  onSubmit("delegateForm", async () => {
    const to = parseAddressInput($("delegateTo").value);
    await sendTx(`Делегування голосів ${short(to)}`, () => app.contracts.token.delegate(to));
  });

  document.addEventListener("click", guard(async (event) => {
    const el = event.target.closest("button");
    if (!el || el.disabled || !app.contracts) return;
    const { governor, treasury, token } = app.contracts;

    if (el.dataset.vote !== undefined) {
      const id = BigInt(el.dataset.id);
      const support = Number(el.dataset.vote);
      const label = ["Проти", "За", "Утриматись"][support];
      await sendTx(`Голос «${label}» за #${id}`, () => governor.castVote(id, support));
    } else if (el.dataset.execute) {
      const id = BigInt(el.dataset.execute);
      await sendTx(`Виконання пропозиції #${id}`, () => governor.execute(id));
    } else if (el.dataset.action === "withdraw") {
      await sendTx("Отримання виплати", () => treasury.withdraw());
    } else if (el.dataset.action === "delegateSelf") {
      await sendTx("Делегування голосів собі", () => token.delegate(app.account));
    } else if (el.dataset.action === "pause" || el.dataset.action === "unpause") {
      const contract = el.dataset.target === "governor" ? governor : treasury;
      const name = el.dataset.target === "governor" ? "Governor" : "Treasury";
      const verb = el.dataset.action === "pause" ? "Пауза" : "Відновлення";
      await sendTx(`${verb} ${name}`, () => contract[el.dataset.action]());
    } else if (el.dataset.time) {
      await advanceLocalTime(Number(el.dataset.time));
    }
  }));

  /// Local Hardhat only: moves chain time forward to demonstrate deadlines.
  async function advanceLocalTime(seconds) {
    const rpc = new ethers.JsonRpcProvider(LOCAL_RPC);
    await rpc.send("evm_increaseTime", [seconds]);
    await rpc.send("evm_mine", []);
    toast(`Час локальної мережі зсунуто на ${formatDuration(seconds)}.`, "ok");
    await refresh();
  }

  // Periodic refresh keeps countdowns and time-dependent states current
  // even when no new blocks or events arrive.
  setInterval(() => {
    if (app.contracts && !$("app").hidden) refresh();
  }, 15000);

  if (window.ethereum) {
    window.ethereum.on("accountsChanged", () => setup().catch((e) => toast(explain(e), "error")));
    window.ethereum.on("chainChanged", () => window.location.reload());
    setup().catch(() => showDisconnected());
  }
})();
