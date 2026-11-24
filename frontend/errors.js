// Turns wallet / RPC / contract errors into clear Ukrainian messages.
(function () {
  const { ethers } = window;
  const fmt = (v) => `${ethers.formatEther(v)} ETH`;

  const STATE_NAMES = ["Очікує знімка", "Активна", "Відхилена", "Ухвалена", "Виконана"];

  const ROLE_NAMES = {
    [ethers.ZeroHash]: "адміністратор (DEFAULT_ADMIN_ROLE)",
    [ethers.id("PROPOSER_ROLE")]: "автор пропозицій (PROPOSER_ROLE)",
    [ethers.id("GUARDIAN_ROLE")]: "охоронець (GUARDIAN_ROLE)",
  };

  const MESSAGES = {
    // DAOGovernor
    InvalidAddress: () => "Адреса не може бути нульовою.",
    InvalidContractAddress: ([a]) => `За адресою ${a} немає контракту.`,
    InvalidVotingPeriod: ([p]) => `Недопустима тривалість голосування: ${p} с.`,
    InvalidAmount: () => "Сума має бути більшою за нуль.",
    InvalidDescriptionLength: ([len]) =>
      `Опис має містити від 1 до 512 байтів (зараз ${len}).`,
    UnknownProposal: ([id]) => `Пропозиції #${id} не існує.`,
    InvalidVoteType: () => "Невідомий тип голосу.",
    AlreadyVoted: ([id]) => `Ви вже проголосували за пропозицію #${id}.`,
    NoVotingPower: () =>
      "На момент створення пропозиції у вас не було делегованих голосів. " +
      "Голосувати можна лише токенами, делегованими до створення пропозиції.",
    InvalidPageSize: ([l]) => `Недопустимий розмір сторінки: ${l}.`,
    SnapshotNotReady: () => "Знімок голосів ще не зафіксовано — дочекайтеся наступного блоку.",
    UnexpectedProposalState: ([id, current, required]) =>
      `Пропозиція #${id} зараз у стані «${STATE_NAMES[Number(current)]}», ` +
      `а для цієї дії потрібен стан «${STATE_NAMES[Number(required)]}».`,

    // DAOTreasury
    InvalidGovernor: () => "Governor має бути контрактом.",
    GovernorAlreadySet: () => "Governor уже прив'язано до скарбниці.",
    UnauthorizedGovernor: ([caller]) =>
      `Резервувати виплати може лише контракт голосування (виклик від ${caller}).`,
    ZeroAmount: () => "Сума має бути більшою за нуль.",
    PayoutAlreadyReserved: ([id]) => `Виплату за пропозицією #${id} уже зарезервовано.`,
    InsufficientAvailableFunds: ([available, requested]) =>
      `У скарбниці недостатньо вільних коштів: доступно ${fmt(available)}, потрібно ${fmt(requested)}. ` +
      "Поповніть скарбницю і повторіть виконання.",
    NothingToWithdraw: () => "Для вашої адреси немає коштів до отримання.",
    TransferFailed: () => "Ваша адреса відхилила переказ ETH. Право на виплату збережено.",

    // OpenZeppelin
    AccessControlUnauthorizedAccount: ([account, role]) =>
      `Акаунт ${account} не має ролі «${ROLE_NAMES[role] || role}».`,
    EnforcedPause: () => "Контракт призупинено (аварійна пауза). Дія тимчасово недоступна.",
    ExpectedPause: () => "Контракт не перебуває на паузі.",
    ReentrancyGuardReentrantCall: () => "Повторний вхід заборонено.",
    ERC20InsufficientBalance: ([, balance, needed]) =>
      `Недостатньо DVT: є ${ethers.formatEther(balance)}, потрібно ${ethers.formatEther(needed)}.`,
    ERC20InvalidReceiver: () => "Недопустимий отримувач токенів.",
  };

  let interfaces = [];

  function init(abis) {
    interfaces = Object.values(abis).map((abi) => new ethers.Interface(abi));
  }

  /// Finds revert data (0x…) anywhere inside a nested error object.
  function findRevertData(error, depth = 0) {
    if (!error || depth > 6) return null;
    if (typeof error === "string") {
      return /^0x[0-9a-fA-F]{8,}$/.test(error) ? error : null;
    }
    if (typeof error !== "object") return null;

    for (const key of ["data", "error", "info", "cause", "originalError", "payload"]) {
      if (key in error) {
        const found = findRevertData(error[key], depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function decodeCustomError(data) {
    for (const iface of interfaces) {
      try {
        const parsed = iface.parseError(data);
        if (parsed) return parsed;
      } catch (_) { /* try next interface */ }
    }
    return null;
  }

  /// Returns a human-readable message for any error.
  function explain(error) {
    if (!error) return "Невідома помилка.";

    if (
      error.code === "ACTION_REJECTED" ||
      error.code === 4001 ||
      error?.info?.error?.code === 4001
    ) {
      return "Ви скасували транзакцію в MetaMask.";
    }

    if (error.code === "INSUFFICIENT_FUNDS") {
      return "Недостатньо ETH на балансі гаманця для оплати транзакції та газу.";
    }

    if (error.revert && MESSAGES[error.revert.name]) {
      return MESSAGES[error.revert.name](error.revert.args);
    }

    const data = findRevertData(error);
    if (data) {
      const parsed = decodeCustomError(data);
      if (parsed) {
        const make = MESSAGES[parsed.name];
        return make ? make(parsed.args) : `Контракт відхилив транзакцію: ${parsed.name}.`;
      }
    }

    if (error.reason) return `Контракт відхилив транзакцію: ${error.reason}`;
    if (error.code === "NETWORK_ERROR") return "Немає з'єднання з мережею.";
    if (error.code === "INVALID_ARGUMENT") return "Перевірте введені дані: некоректне значення.";

    const short = error.shortMessage || error.message || String(error);
    return short.length > 200 ? `${short.slice(0, 200)}…` : short;
  }

  window.DAOErrors = { init, explain, STATE_NAMES, ROLE_NAMES };
})();
