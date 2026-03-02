// --- FORMATTING UTILS ---
window.parseFormattedNumber = function (val) {
    if (typeof val === 'number') return val;
    if (!val) return 0;
    return parseFloat(val.toString().replace(/,/g, '')) || 0;
};

document.addEventListener('input', function (e) {
    if (e.target.classList.contains('currency-input')) {
        let val = e.target.value.replace(/[^0-9.]/g, '');
        let parts = val.split('.');
        if (parts.length > 2) parts = [parts[0], parts[1]];
        if (parts.length > 1) parts[1] = parts[1].slice(0, 2);
        if (parts[0].length > 0) parts[0] = parseInt(parts[0], 10).toLocaleString('en-US');
        e.target.value = parts.join('.');
    } else if (e.target.classList.contains('number-input')) {
        let val = e.target.value.replace(/[^0-9]/g, '');
        if (val.length > 0) e.target.value = parseInt(val, 10).toLocaleString('en-US');
        else e.target.value = '';
    }
});

document.addEventListener('blur', function (e) {
    if (e.target.classList.contains('currency-input')) {
        let val = parseFormattedNumber(e.target.value);
        if (!isNaN(val) && e.target.value !== '') {
            e.target.value = val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }
    }
}, true);

// --- 1. CONFIG MULTI-CATEGORY UPDATE ----
const DEFAULT_CONFIG = {
    policyName: "Policyholder",
    policyAge: 30, policyNIC: "", policyNo: "", policyTerm: 30,
    monthlyPremium: 5000, premiumFrequency: "Monthly",
    activeYear: 1, activeDate: "",
    baseCover: 750000, criticalCover: 1000000, hospitalPerDay: 8000, hospitalRoomPct: 2.0,
    overdueRiskDays: 26, noClaimBonusPct: 25, appPin: "",
    innerLimits: { // NEW DYNAMIC STRUCTURE FOR INNER LIMITS %
        'OPD': { pct: 1.0, icon: 'fa-stethoscope text-green-500' },
        'Spectacles': { pct: 1.0, icon: 'fa-glasses text-teal-500' },
        'Dental': { pct: 1.0, icon: 'fa-tooth text-cyan-500' }
    }
};

let config = JSON.parse(localStorage.getItem('policyConfig'));

// Icon mapper with fallback for unknown custom categories
const CATEGORY_ICONS = {
    'OPD': 'fa-stethoscope text-green-500',
    'Spectacles': 'fa-glasses text-teal-500',
    'Dental': 'fa-tooth text-cyan-500',
    'Maternity': 'fa-baby text-pink-500',
    'Hearing': 'fa-ear-listen text-orange-500',
    'Therapy': 'fa-crutch text-purple-500',
    'Pharmacy': 'fa-pills text-blue-500',
    'Nursing': 'fa-user-nurse text-rose-500'
};
const fallbackIcon = 'fa-tag text-slate-400';

// Data Migration for older configs
if (!config || typeof config !== 'object') {
    config = DEFAULT_CONFIG;
} else {
    // Apply defaults for missing new keys
    for (let key in DEFAULT_CONFIG) if (config[key] === undefined) config[key] = DEFAULT_CONFIG[key];
    // Migrate old fixed limits to dynamic structure if it doesn't exist
    if (!config.innerLimits) {
        config.innerLimits = {};
        if (config.opdPct !== undefined) config.innerLimits['OPD'] = { pct: config.opdPct, icon: CATEGORY_ICONS['OPD'] };
        if (config.specPct !== undefined) config.innerLimits['Spectacles'] = { pct: config.specPct, icon: CATEGORY_ICONS['Spectacles'] };
        if (config.dentalPct !== undefined) config.innerLimits['Dental'] = { pct: config.dentalPct, icon: CATEGORY_ICONS['Dental'] };
    } else {
        // Migrate purely numeric limit records to objects with icons
        for (let k in config.innerLimits) {
            if (typeof config.innerLimits[k] === 'number') {
                config.innerLimits[k] = { pct: config.innerLimits[k], icon: CATEGORY_ICONS[k] || fallbackIcon };
            }
        }
    }
}
function saveConfig() { localStorage.setItem('policyConfig', JSON.stringify(config)); if (typeof autoSyncToCloud === 'function') autoSyncToCloud(); }

function getCalculatedInnerLimits() {
    let lims = {};
    for (const [cat, data] of Object.entries(config.innerLimits)) {
        lims[cat] = (config.baseCover * data.pct) / 100;
    }
    return lims;
}

// --- 2. DB ---
const db = new Dexie('InsuranceTrackerDB_Revised');
db.version(2).stores({
    claims: '++id, policyYear, date, category, amount, hospital, description, days, timestamp',
    premiums: '++id, policyYear, paidDate, dueDate, amount, timestamp'
});
db.version(3).stores({
    policyDocs: '++id, name, type, data, timestamp'
});
db.version(4).stores({
    claims: '++id, syncId, policyYear, date, category, amount, hospital, description, days, timestamp',
    premiums: '++id, syncId, policyYear, paidDate, dueDate, amount, timestamp'
}).upgrade(tx => {
    return Promise.all([
        tx.claims.toCollection().modify(claim => {
            if (!claim.syncId) claim.syncId = Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
        }),
        tx.premiums.toCollection().modify(premium => {
            if (!premium.syncId) premium.syncId = Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
        })
    ]);
});

// Trackers
let usedTotals = { 'Total': 0, 'Critical': 0 };
let usedInner = {};

let editingClaimId = null;
let editingPremiumId = null;
let isPremiumHighRiskOverdue = false;

// --- 3. UI HELPER ---
let currentClaimsViewingYear = null;
let currentRealYear = 1;

function changeClaimsViewingYear(year) {
    currentClaimsViewingYear = parseInt(year);
    document.querySelectorAll('.tableYearDisplay').forEach(el => {
        el.innerText = currentClaimsViewingYear === currentRealYear ? `${currentClaimsViewingYear} - Current` : currentClaimsViewingYear;
    });
    renderClaimsTable();
}

async function populateClaimsYearSelect() {
    const claims = await db.claims.toArray();
    let yearsWithClaims = [...new Set(claims.map(c => Number(c.policyYear)))];

    const select = document.getElementById('claimsYearSelect');
    if (!select) return;

    if (!yearsWithClaims.includes(Number(config.activeYear))) yearsWithClaims.push(Number(config.activeYear));
    yearsWithClaims.sort((a, b) => a - b);

    select.innerHTML = yearsWithClaims.map(y => {
        let text = `Year ${y}`;
        if (y === currentRealYear) text += ` (Current)`;
        return `<option value="${y}">${text}</option>`;
    }).join('');

    if (!currentClaimsViewingYear || !yearsWithClaims.includes(currentClaimsViewingYear)) {
        currentClaimsViewingYear = Number(config.activeYear);
    }

    select.value = currentClaimsViewingYear;
}

function changeViewingYear(year) {
    config.activeYear = parseInt(year);
    saveConfig();
    currentClaimsViewingYear = config.activeYear;
    initApp();
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    if (event) event.currentTarget.classList.add('active');
    else {
        let btn = document.querySelector(`.tab-btn[onclick="switchTab('${tabId}')"]`);
        if (btn) btn.classList.add('active');
    }
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(`tab-${tabId}`).classList.add('active');

    if (tabId === 'settings') populateSettingsForm();
    if (tabId === 'report') renderReportTab();
    if (tabId === 'premiums') renderPremiumsTable();
}

function toggleDaysInput() {
    const cat = document.getElementById('claimCategory').value;
    const group = document.getElementById('daysInputGroup');
    const daysInput = document.getElementById('claimDays');
    if (cat === 'Hospital Room') { group.classList.remove('hidden'); daysInput.required = true; }
    else { group.classList.add('hidden'); daysInput.required = false; daysInput.value = ''; }
}

function formatRs(amt) { return 'Rs. ' + Number(amt).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// --- 4. INIT ---
async function initApp() {
    // Calculate Current Real Year based on Active Date
    let realYear = 1;
    let daysLeft = 365;
    if (config.activeDate) {
        const actDate = new Date(config.activeDate);
        const now = new Date();
        const diffTime = now.getTime() - actDate.getTime();
        if (diffTime >= 0) {
            const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
            currentRealYear = Math.floor(diffDays / 365) + 1;
            daysLeft = 365 - (diffDays % 365);
        }
    }
    if (!config.activeYear || config.activeYear > config.policyTerm) config.activeYear = currentRealYear; // Default view is actual year

    // Update Dashboard UI Elements
    const dashYearSelect = document.getElementById('dashYearSelect');
    if (dashYearSelect) {
        dashYearSelect.innerHTML = Array.from({ length: config.policyTerm }, (_, i) => {
            let text = `Year ${i + 1}`;
            if (i + 1 === currentRealYear) text += ` (Current)`;
            return `<option value="${i + 1}">${text}</option>`;
        }).join('');
        dashYearSelect.value = config.activeYear;
    }

    const renewalInfo = document.getElementById('renewalInfo');
    if (renewalInfo && config.activeDate) {
        renewalInfo.classList.remove('hidden');
        renewalInfo.innerText = `Renews in ${daysLeft} days`;
    }

    // Update Select Dropdowns dynamically based on Policy Term
    const yearOptions = Array.from({ length: config.policyTerm }, (_, i) => `<option value="${i + 1}">Year ${i + 1}</option>`).join('');
    document.getElementById('premPolicyYear').innerHTML = yearOptions;

    // Populate Form Dropdown Categories dynamically Based on Inner limits + Core ones
    const catSelect = document.getElementById('claimCategory');
    let catOptions = `<option value="" disabled selected>Select...</option>
                <option value="General Claim">General Claim (Normal Bill)</option>
                <option value="Hospital Room">Hospitalization / Room</option>
                <option value="Critical Illness">Critical Illness</option>
                <optgroup label="Custom Inner Limits">`;
    for (const cat of Object.keys(config.innerLimits)) { catOptions += `<option value="${cat}">${cat}</option>`; }
    catOptions += `</optgroup>`;
    catSelect.innerHTML = catOptions;

    document.getElementById('dashGreeting').innerText = `Hello, ${config.policyName}${config.policyAge ? ` (${config.policyAge} Yrs)` : ''}`;
    document.getElementById('dashPolicyNo').innerText = config.policyNo || '-';
    document.getElementById('claimPolicyYear').value = config.activeYear;

    await populateClaimsYearSelect();
    document.querySelectorAll('.tableYearDisplay').forEach(el => {
        el.innerText = currentClaimsViewingYear === currentRealYear ? `${currentClaimsViewingYear} - Current` : currentClaimsViewingYear;
    });

    // Actual Premiums
    const allPrems = await db.premiums.toArray();
    let sumPrem = allPrems.reduce((sum, p) => sum + parseFloat(p.amount), 0);
    document.getElementById('dashPremiumPaid').innerText = formatRs(sumPrem);

    // Populate forms
    document.getElementById('claimDate').valueAsDate = new Date();
    document.getElementById('premPaidDate').valueAsDate = new Date();
    document.getElementById('premPolicyYear').value = config.activeYear;

    await calculateTotalsForActiveYear();
    renderProgressBars();
    await renderClaimsTable();
    await calculateNextPremium();
}

async function calculateNextPremium() {
    const reminderDiv = document.getElementById('dashPremiumReminder');
    const premAmountField = document.getElementById('premAmount');
    const premDueDateField = document.getElementById('premDueDate');

    if (!config.activeDate || !config.premiumFrequency) {
        reminderDiv.classList.add('hidden');
        if (premAmountField) premAmountField.value = config.monthlyPremium;
        return;
    }

    const allPrems = await db.premiums.toArray();
    const paidDatesStr = allPrems.map(p => p.dueDate);

    let nextDate = new Date(config.activeDate);
    let nextDateStr = '';

    while (true) {
        nextDateStr = nextDate.toISOString().split('T')[0];
        if (!paidDatesStr.includes(nextDateStr)) {
            break;
        }
        if (config.premiumFrequency === 'Monthly') nextDate.setMonth(nextDate.getMonth() + 1);
        else if (config.premiumFrequency === 'Quarterly') nextDate.setMonth(nextDate.getMonth() + 3);
        else if (config.premiumFrequency === 'Half Yearly') nextDate.setMonth(nextDate.getMonth() + 6);
        else if (config.premiumFrequency === 'Yearly') nextDate.setFullYear(nextDate.getFullYear() + 1);
    }

    // Fill Add Premium form defaults
    if (premAmountField) premAmountField.value = config.monthlyPremium;
    if (premDueDateField) premDueDateField.value = nextDateStr;

    // Render Dashboard card
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const timeDiff = nextDate.getTime() - today.getTime();
    const daysLeft = Math.ceil(timeDiff / (1000 * 3600 * 24));

    let alertHtml = '';
    let styleClass = '';
    let iconClass = '';

    let freqLabel = config.premiumFrequency === 'Monthly' ? 'Monthly' : config.premiumFrequency;

    isPremiumHighRiskOverdue = false;
    document.body.classList.remove('bg-rose-50');
    let navBar = document.querySelector('nav');
    if (navBar) navBar.className = "bg-brand-600 dark:bg-slate-900 text-white shadow-md sticky top-0 z-40 transition-colors";

    const riskDaysLimit = config.overdueRiskDays !== undefined ? config.overdueRiskDays : 26;

    if (daysLeft < -riskDaysLimit) {
        isPremiumHighRiskOverdue = true;
        styleClass = "border-l-4 border-rose-600 bg-white shadow-lg shadow-rose-200/50";
        iconClass = "fa-circle-exclamation text-rose-600 bg-rose-100 p-2.5 rounded-full animate-pulse";
        alertHtml = `<strong class="text-rose-700 block text-base mb-1 uppercase tracking-wide"><i class="fa-solid fa-lock mr-1"></i> High Risk: Account Locked!</strong> <span class="text-rose-800 font-medium">Your ${freqLabel} payment of <strong>${formatRs(config.monthlyPremium)}</strong> is severely overdue by <span class="text-rose-900 font-black">${Math.abs(daysLeft)} days</span>. Claim submissions are blocked until the payment is settled.</span>`;
        document.body.classList.add('bg-rose-50');
        if (navBar) navBar.className = "bg-rose-700 text-white shadow-md sticky top-0 z-40 transition-colors border-b-4 border-rose-900";
    } else if (daysLeft < 0) {
        styleClass = "border-l-4 border-rose-500 text-slate-700 bg-white";
        iconClass = "fa-circle-exclamation text-rose-500 bg-rose-50 p-2.5 rounded-full";
        alertHtml = `<strong class="text-rose-600 block mb-0.5">Overdue Payment!</strong> <span class="text-slate-500">${freqLabel} payment of <strong>${formatRs(config.monthlyPremium)}</strong> was due on <span class="text-slate-700 font-semibold">${nextDateStr}</span> (${Math.abs(daysLeft)} days ago).</span>`;
    } else if (daysLeft <= 7) {
        styleClass = "border-l-4 border-orange-500 text-slate-700 bg-white";
        iconClass = "fa-bell text-orange-500 bg-orange-50 p-2.5 rounded-full";
        alertHtml = `<strong class="text-orange-600 block mb-0.5">Payment Due Soon!</strong> <span class="text-slate-500">${freqLabel} payment of <strong>${formatRs(config.monthlyPremium)}</strong> is due on <span class="text-slate-700 font-semibold">${nextDateStr}</span> (in ${daysLeft} days).</span>`;
    } else {
        styleClass = "border-l-4 border-blue-500 text-slate-700 bg-white";
        iconClass = "fa-calendar-check text-blue-500 bg-blue-50 p-2.5 rounded-full";
        alertHtml = `<strong class="text-blue-600 block mb-0.5">Next Scheduled Payment</strong> <span class="text-slate-500">${freqLabel} payment of <strong class="text-slate-700 font-semibold">${formatRs(config.monthlyPremium)}</strong> is due on <span class="text-slate-700 font-semibold">${nextDateStr}</span> (in ${daysLeft} days).</span>`;
    }

    reminderDiv.innerHTML = `
                <div class="rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between shadow-md shadow-slate-200/50 border border-slate-100 gap-4 md:gap-0 ${styleClass}">
                    <div class="flex items-center gap-4">
                        <i class="fa-solid ${iconClass} text-xl"></i>
                        <div class="text-[13px] border-l-2 pl-4 border-slate-100 leading-snug">${alertHtml}</div>
                    </div>
                    <button onclick="switchTab('premiums')" class="bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold px-6 py-2.5 rounded-lg shadow-sm hover:shadow transition whitespace-nowrap"><i class="fa-solid fa-coins mr-1.5 text-blue-400"></i> Pay Now</button>
                </div>
            `;
    reminderDiv.classList.remove('hidden');
}

async function calculateTotalsForActiveYear() {
    usedTotals = { 'Total': 0, 'General': 0, 'NonGeneral': 0, 'Critical': 0, 'HospitalDays': 0, 'HospitalBenefit': 0, 'HospitalRoomValue': 0, 'HospitalRoomDays': 0, 'NoClaimBonus': 0 };
    usedInner = {};
    for (let cat in config.innerLimits) usedInner[cat] = 0; // Initialize configured inner limits with 0

    // No Claim Bonus Logic
    let consecutiveNoClaimYears = 0;
    const configNcbPct = config.noClaimBonusPct !== undefined ? config.noClaimBonusPct : 25; // Default to 25% if not set
    for (let y = config.activeYear - 1; y >= 1; y--) {
        const claimsInYear = await db.claims.where('policyYear').equals(y).toArray();
        if (claimsInYear.length === 0) {
            consecutiveNoClaimYears++;
        } else {
            break;
        }
    }

    if (consecutiveNoClaimYears > 0) {
        let bonusPct = Math.min(consecutiveNoClaimYears * (configNcbPct / 100), (configNcbPct * 4) / 100);
        usedTotals['NoClaimBonus'] = config.baseCover * bonusPct;
    }

    const records = await db.claims.where('policyYear').equals(Number(config.activeYear)).toArray();
    records.forEach(req => {
        let amt = parseFloat(req.amount);
        if (req.category === 'Critical Illness') {
            // Critical illness handled separately below
        } else if (req.category === 'Hospital Room') {
            usedTotals['Total'] += amt; // Goes to Base Cover
            usedTotals['NonGeneral'] += amt;
            usedTotals['HospitalRoomValue'] += amt;
            usedTotals['HospitalRoomDays'] += (req.days && typeof req.days === 'number') ? parseInt(req.days) : 0;

            // Track Hospital Per Day Benefit
            if (req.days && req.days > 2) {
                const benefit = req.days * config.hospitalPerDay;
                usedTotals['HospitalDays'] += req.days;
                usedTotals['HospitalBenefit'] += benefit;
            }
        } else if (req.category === 'General Claim') {
            usedTotals['Total'] += amt; // Everything else goes to Base Cover
            usedTotals['General'] += amt;
        } else {
            usedTotals['Total'] += amt; // Everything else goes to Base Cover

            // Track dynamic inner categories
            if (config.innerLimits[req.category] !== undefined) {
                if (!usedInner[req.category]) usedInner[req.category] = 0;
                usedInner[req.category] += amt;
            }
            // General claims are excluded from NonGeneral limit, everything else is NonGeneral
            usedTotals['NonGeneral'] += amt;
        }
    });

    // Critical Illness is lifetime, calculated across all years
    const criticalRecords = await db.claims.where('category').equals('Critical Illness').toArray();
    criticalRecords.forEach(req => {
        usedTotals['Critical'] += parseFloat(req.amount);
    });
}

// --- 5. RENDER DASHBOARD & CLAIMS ---
function renderProgressBars() {
    const container = document.getElementById('progressBarsContainer');
    container.innerHTML = '';
    const calcLimits = getCalculatedInnerLimits();

    // 1. MASTER BASE COVER & CRITICAL
    let currentMasterCover = config.baseCover + usedTotals['NoClaimBonus'];
    let tRem = currentMasterCover - usedTotals['Total'];
    let tPct = Math.min((usedTotals['Total'] / currentMasterCover) * 100, 100);
    let tCol = tPct >= 90 ? 'bg-red-500' : (tPct >= 75 ? 'bg-amber-500' : 'bg-brand-500');

    let cRem = config.criticalCover - usedTotals['Critical'];
    let cPct = Math.min((usedTotals['Critical'] / config.criticalCover) * 100, 100);

    let html1 = `
                <div class="space-y-4">
                    <h3 class="font-bold text-slate-700 mb-2 border-b border-slate-100 pb-2">Master Covers</h3>
                    <!-- Base -->
                    <div class="p-4 border border-brand-200 bg-brand-50 rounded-lg">
                        <div class="flex justify-between items-end mb-1">
                            <span class="font-semibold text-slate-800"><i class="fa-solid fa-umbrella text-brand-600"></i> Overall Policy Cover ${usedTotals['NoClaimBonus'] > 0 ? `<span class="bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded ml-2 font-bold">+No Claim Bonus!</span>` : ''}</span>
                            <span class="text-xs text-slate-500 font-bold max-w-[50%] text-right truncate" title="Max: ${formatRs(currentMasterCover)}">Max: ${formatRs(currentMasterCover)}<br>${usedTotals['NoClaimBonus'] > 0 ? `<span class="text-xs font-semibold text-green-600">(Inc. ${formatRs(usedTotals['NoClaimBonus'])} Bonus)</span>` : ''}</span>
                        </div>
                        <div class="w-full bg-slate-200 rounded-full h-2 mb-1"><div class="${tCol} h-2 rounded-full" style="width: ${tPct}%"></div></div>
                        <div class="flex justify-between items-center px-1 mt-2">
                            <div>
                                <p class="text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-1">Used Amount</p>
                                <p class="text-xl font-bold text-brand-700">${formatRs(usedTotals['Total'])}</p>
                            </div>
                            <div class="text-right">
                                <p class="text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-1">Balance</p>
                                <p class="text-xl font-bold text-brand-800">${formatRs(Math.max(0, tRem))}</p>
                            </div>
                        </div>
                    </div>
                    <!-- Hospital Room Limit -->
                    <div class="p-4 border border-brand-200 bg-brand-50 rounded-lg shrink-0 mt-4">
                        <div class="flex justify-between items-end mb-1 border-b border-brand-100 pb-2">
                            <span class="font-semibold text-slate-800"><i class="fa-solid fa-bed text-brand-600"></i> Hospital Room Expenses</span>
                            <span class="text-xs text-brand-600 font-bold max-w-[50%] text-right truncate bg-brand-100 px-2 py-0.5 rounded-full">Per Day Cap: ${config.hospitalRoomPct}% of Base</span>
                        </div>
                        <div class="mt-2 flex justify-between items-center px-1">
                            <div>
                                <p class="text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-1">Total Claimed (YTD)</p>
                                <p class="text-xl font-bold text-brand-700">${formatRs(usedTotals['HospitalRoomValue'])} <span class="text-xs ml-1 font-semibold text-brand-600 bg-brand-100/70 border border-brand-200 px-1.5 py-0.5 rounded-full inline-block align-middle transform -translate-y-[2px]">${usedTotals['HospitalRoomDays']} Days</span></p>
                            </div>
                            <div class="text-right flex flex-col items-end justify-center">
                                <p class="text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-1">Max Per Day Limit</p>
                                <p class="text-xs font-bold text-slate-500">${formatRs(config.baseCover * (config.hospitalRoomPct / 100))}</p>
                            </div>
                        </div>
                        <div class="text-[10px] text-brand-700 mt-3 font-medium px-2 py-1.5 text-center bg-brand-100/50 rounded-md border border-brand-200 border-dashed">
                            <i class="fa-solid fa-circle-check mr-1 text-brand-500"></i> Amounts reduce Overall Policy Cover.
                        </div>
                    </div>
                    <!-- Critical -->
                    <div class="p-4 border border-amber-200 bg-amber-50 rounded-lg shrink-0">
                        <div class="flex justify-between items-end mb-1">
                            <span class="font-semibold text-slate-800"><i class="fa-solid fa-heart-crack text-amber-600"></i> Critical Illness Cover <span class="bg-amber-100 text-amber-700 text-[10px] px-1.5 py-0.5 rounded ml-1">Lifetime</span></span>
                            <span class="text-xs text-slate-500 font-bold max-w-[50%] text-right truncate" title="Max: ${formatRs(config.criticalCover)}">Max: ${formatRs(config.criticalCover)}</span>
                        </div>
                        <div class="w-full bg-slate-200 rounded-full h-2 mb-1"><div class="bg-amber-500 h-2 rounded-full" style="width: ${cPct}%"></div></div>
                        <div class="flex justify-between items-center px-1 mt-2">
                            <div>
                                <p class="text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-1">Used Amount</p>
                                <p class="text-xl font-bold text-amber-600">${formatRs(usedTotals['Critical'])}</p>
                            </div>
                            <div class="text-right">
                                <p class="text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-1">Balance</p>
                                <p class="text-xl font-bold text-amber-800">${formatRs(Math.max(0, cRem))}</p>
                            </div>
                        </div>
                    </div>
                    
                    <!-- Hospital Cash Benefit -->
                    <div class="p-4 border border-blue-200 bg-blue-50 rounded-lg shrink-0 mt-4">
                        <div class="flex justify-between items-end mb-1 border-b border-blue-100 pb-2">
                            <span class="font-semibold text-slate-800"><i class="fa-solid fa-bed-pulse text-blue-600"></i> Hospital Cash Benefit</span>
                            <span class="text-xs text-blue-600 font-bold max-w-[50%] text-right truncate bg-blue-100 px-2 py-0.5 rounded-full" title="Earned when hospitalized for more than 2 nights">&gt; 2 Nights Only</span>
                        </div>
                        <div class="mt-2 flex justify-between items-center px-1">
                            <div>
                                <p class="text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-1">Total Earned</p>
                                <p class="text-lg font-bold text-blue-700">${formatRs(usedTotals['HospitalBenefit'])}</p>
                            </div>
                            <div class="text-right">
                                <p class="text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-1">Eligible Nights</p>
                                <p class="text-lg font-bold text-blue-700">${usedTotals['HospitalDays']} Nights</p>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- Dynamic Inner Limits Wrapper -->
                <div class="space-y-4">
                    <h3 class="font-bold text-slate-700 mb-2 border-b border-slate-100 pb-2">Inner Limit Trackings</h3>
            `;

    // Dynamic Inner limits mapping
    const innerKeys = Object.keys(config.innerLimits);
    if (innerKeys.length === 0) {
        html1 += `<div class="text-sm text-slate-400 italic">No custom inner limits configured in policy config.</div>`;
    } else {
        innerKeys.forEach(cat => {
            let max = calcLimits[cat], used = usedInner[cat] || 0, rem = Math.max(0, max - used);
            let pctLimit = config.innerLimits[cat].pct;
            let pct = Math.min((used / max) * 100, 100);
            let col = pct >= 90 ? 'bg-red-400' : (pct >= 75 ? 'bg-amber-400' : 'bg-indigo-400');
            let ic = config.innerLimits[cat].icon || fallbackIcon;

            html1 += `
                    <div>
                        <div class="flex justify-between text-sm mb-1"><span class="font-medium text-slate-700 flex items-center gap-1.5"><i class="fa-solid ${ic}"></i> ${cat} <span class="bg-slate-100 text-slate-400 text-[10px] px-1.5 py-0.5 rounded ml-1 border border-slate-200">${pctLimit}%</span></span><span class="text-xs text-slate-500">Cap: ${formatRs(max)}</span></div>
                        <div class="w-full bg-slate-100 rounded-full h-1.5 mb-1"><div class="${col} h-1.5 rounded-full" style="width: ${pct}%"></div></div>
                        <div class="flex justify-between items-center px-1 mt-2">
                            <div>
                                <p class="text-[9px] text-slate-400 uppercase font-bold tracking-wider mb-0.5">Used</p>
                                <p class="text-lg font-bold text-slate-700">${formatRs(used)}</p>
                            </div>
                            <div class="text-right">
                                <p class="text-[9px] text-slate-400 uppercase font-bold tracking-wider mb-0.5">Balance</p>
                                <p class="text-lg font-bold ${rem === 0 ? 'text-red-500' : 'text-brand-600'}">${formatRs(rem)}</p>
                            </div>
                        </div>
                    </div>
                    `;
        });
    }
    html1 += `</div></div>`; // Close innerWrapper & main wrapper
    container.innerHTML = html1;
}


async function renderClaimsTable() {
    const tableBody = document.getElementById('claimsTableBody');
    const noMessage = document.getElementById('noClaimsMessage');

    tableBody.innerHTML = '';
    const yearToFetch = currentClaimsViewingYear || Number(config.activeYear);
    const claims = await db.claims.where('policyYear').equals(yearToFetch).reverse().sortBy('date');

    if (claims.length === 0) { noMessage.classList.remove('hidden'); return; }
    noMessage.classList.add('hidden');

    claims.forEach(c => {
        const tr = document.createElement('tr'); tr.className = 'border-b border-slate-50';
        tr.innerHTML = `
                    <td data-label="Date" class="px-6 py-3 text-slate-600 text-xs">${c.date}</td>
                    <td data-label="Category" class="px-6 py-3 text-xs font-semibold text-slate-700 whitespace-normal min-w-[120px]">${c.category} ${c.days ? `<span class="bg-indigo-50 text-indigo-700 px-1 py-0.5 rounded border border-indigo-100 mt-1 block w-max">${c.days}D</span>` : ''}</td>
                    <td data-label="Desc/Hosp" class="px-6 py-3 text-slate-800 text-xs whitespace-normal min-w-[150px]">${c.hospital} <div class="text-[10px] text-slate-400 italic">${c.description || ''}</div></td>
                    <td data-label="Amount" class="px-6 py-3 text-right font-bold text-slate-800">${formatRs(c.amount)}</td>
                    <td class="px-6 py-3 text-center whitespace-nowrap actions-cell">
                        <button onclick="${c.fileData ? `viewDocument('${c.fileData}', '${c.fileType}')` : `Swal.fire('No File','No attachment saved.','info')`}" class="${c.fileData ? 'text-blue-500' : 'text-slate-300'} mr-3 p-1 hover:bg-slate-50 rounded" title="View"><i class="fa-solid fa-eye text-lg"></i></button>
                        <button onclick="editRow('claims', ${c.id})" class="text-indigo-500 hover:text-indigo-700 mr-3 p-1 hover:bg-indigo-50 rounded" title="Edit"><i class="fa-solid fa-pen text-lg"></i></button>
                        <button onclick="deleteRow('claims', ${c.id})" class="text-rose-500 hover:text-rose-700 p-1 hover:bg-rose-50 rounded" title="Delete"><i class="fa-solid fa-trash text-lg"></i></button>
                    </td>
                `;
        tableBody.appendChild(tr);
    });
}


// --- 6. CLAIMS LOGIC ---
document.getElementById('claimForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    if (isPremiumHighRiskOverdue) {
        return Swal.fire({
            title: 'Account Locked!',
            text: 'Your premium payment is severely overdue (more than 26 days). Claim submissions are blocked until the pending premium is settled.',
            icon: 'error',
            confirmButtonColor: '#e11d48'
        });
    }

    const date = document.getElementById('claimDate').value;
    const category = document.getElementById('claimCategory').value;
    const amount = parseFormattedNumber(document.getElementById('claimAmount').value);
    const hospital = document.getElementById('claimHospital').value.trim();
    const desc = document.getElementById('claimDescription').value;
    const days = category === 'Hospital Room' ? parseInt(document.getElementById('claimDays').value) : null;
    const py = Number(config.activeYear);
    const file = document.getElementById('claimFile').files[0];

    if (!category) return Swal.fire('Error', 'Select category', 'error');
    const limits = getCalculatedInnerLimits();

    // Validations minus the currently edited claim to not double count
    let validateTotals = JSON.parse(JSON.stringify(usedTotals));
    let validateInner = JSON.parse(JSON.stringify(usedInner));
    if (editingClaimId) {
        // Need to wait inside sync function block to fetch old rec?
        // Let's resolve old data here
    }

    // Wrap validation logic into async operation safely
    const existingOldRec = editingClaimId ? await db.claims.get(editingClaimId) : null;
    if (existingOldRec && existingOldRec.policyYear === Number(config.activeYear)) {
        let oA = parseFloat(existingOldRec.amount);
        if (existingOldRec.category === 'Critical Illness') validateTotals['Critical'] -= oA;
        else if (existingOldRec.category === 'Hospital Room') {
            validateTotals['Total'] -= oA;
            validateTotals['NonGeneral'] -= oA;
        } else if (existingOldRec.category === 'General Claim') {
            validateTotals['Total'] -= oA;
            validateTotals['General'] -= oA;
        } else {
            validateTotals['Total'] -= oA;
            validateTotals['NonGeneral'] -= oA;
            if (validateInner[existingOldRec.category] !== undefined) validateInner[existingOldRec.category] -= oA;
        }
    }

    if (category === 'Critical Illness') {
        const existingCriticalArr = await db.claims.where('category').equals('Critical Illness').toArray();
        const others = editingClaimId ? existingCriticalArr.filter(c => c.id !== editingClaimId) : existingCriticalArr;
        if (others.length > 0) return Swal.fire('Error', 'Critical illness cover can only be claimed once during the entire policy term.', 'error');
        if (amount > (config.criticalCover - validateTotals['Critical'])) return limError(config.criticalCover - validateTotals['Critical']);
    } else {
        let amountToDeduct = amount;
        let currentMasterCover = config.baseCover + (validateTotals['NoClaimBonus'] || 0);

        // Validate Overall Policy Cover (Base + Bonus)
        if (amountToDeduct > (currentMasterCover - validateTotals['Total'])) return limError(currentMasterCover - validateTotals['Total']);

        // Non-General claims cannot consume the No Claim Bonus pool
        if (category !== 'General Claim') {
            let baseUsed = validateTotals['NonGeneral'] + Math.max(0, validateTotals['General'] - (validateTotals['NoClaimBonus'] || 0));
            let availableNonGeneral = config.baseCover - baseUsed;
            if (amountToDeduct > availableNonGeneral) {
                return Swal.fire({ title: 'Bonus Rule limit', html: `Available Base Limit for Non-General Claims: <strong>${formatRs(Math.max(0, availableNonGeneral))}</strong><br><span class="text-[11px] text-slate-500 mt-2 block">Note: The No Claim Bonus (${formatRs(validateTotals['NoClaimBonus'])}) can ONLY be used for General Claims.</span>`, icon: 'error' });
            }
        }

        // Validate Dynamic Inner categories
        if (config.innerLimits[category] !== undefined) {
            if (amount > (limits[category] - validateInner[category])) return limError(limits[category] - validateInner[category]);
        }

        // Validate Hospital Room
        if (category === 'Hospital Room') {
            if (!days) return Swal.fire('Required', 'Days needed', 'warning');

            const roomMaxPerDay = config.baseCover * (config.hospitalRoomPct / 100);
            const roomMaxForClaim = roomMaxPerDay * days;
            if (amount > roomMaxForClaim) return limError(roomMaxForClaim);
        }
    }

    try {
        let existingFileData = null, existingFileType = null;
        if (existingOldRec) {
            existingFileData = existingOldRec.fileData;
            existingFileType = existingOldRec.fileType;
        }

        if (file) {
            const reader = new FileReader();
            reader.onload = async () => {
                const payload = { policyYear: py, date, category, amount, hospital, description: desc, days, fileData: reader.result, fileType: file.type, timestamp: Date.now() };
                if (editingClaimId) {
                    await db.claims.update(editingClaimId, payload);
                } else {
                    payload.syncId = Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
                    await db.claims.add(payload);
                }
                saveSuccess();
            };
            reader.readAsDataURL(file);
        } else {
            const payload = { policyYear: py, date, category, amount, hospital, description: desc, days, fileData: existingFileData, fileType: existingFileType, timestamp: Date.now() };
            if (editingClaimId) {
                await db.claims.update(editingClaimId, payload);
            } else {
                payload.syncId = Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
                await db.claims.add(payload);
            }
            saveSuccess(true);
        }
    } catch (e) { Swal.fire('Error', 'File error', 'error'); }

    function limError(avail) { Swal.fire({ title: 'Limit Exceeded', html: `Available Limit: <strong>${formatRs(Math.max(0, avail))}</strong>`, icon: 'error' }); }
    function saveSuccess(noFile = false) {
        Swal.fire({ title: editingClaimId ? 'Updated' : (noFile ? 'Saved (No Bill)' : 'Saved'), icon: 'success', timer: 1500, showConfirmButton: false });
        cancelEdit('claims');
        currentClaimsViewingYear = Number(config.activeYear); // reset view to where we just added
        initApp();
        if (typeof autoSyncToCloud === 'function') autoSyncToCloud();
    }
});


// --- 6.5 PREMIUMS LOGIC ---
async function renderPremiumsTable() {
    const tbody = document.getElementById('premiumTableBody');
    const noMsg = document.getElementById('noPremiumMessage');
    tbody.innerHTML = '';

    const prems = await db.premiums.reverse().sortBy('dueDate');
    if (prems.length === 0) {
        noMsg.classList.remove('hidden');
        return;
    }
    noMsg.classList.add('hidden');

    prems.forEach(p => {
        const isPaidLate = new Date(p.paidDate) > new Date(p.dueDate);
        const tr = document.createElement('tr');
        tr.className = 'border-b border-slate-50';
        tr.innerHTML = `
                <td data-label="Due Date" class="px-6 py-3 text-slate-600 text-xs" > ${p.dueDate}</td>
                    <td data-label="Paid Date" class="px-6 py-3 text-xs font-semibold ${isPaidLate ? 'text-amber-600' : 'text-green-600'}">${p.paidDate}</td>
                    <td data-label="Year" class="px-6 py-3 text-slate-800 text-xs text-center"><span class="bg-blue-50 text-blue-700 px-2 py-1 rounded font-medium border border-blue-100">Year ${p.policyYear}</span></td>
                    <td data-label="Amount" class="px-6 py-3 text-right font-bold text-slate-800">${formatRs(p.amount)}</td>
                    <td class="px-6 py-3 text-center whitespace-nowrap actions-cell">
                        <button onclick="editRow('premiums', ${p.id})" class="text-indigo-500 hover:text-indigo-700 mr-3 p-1 hover:bg-indigo-50 rounded" title="Edit"><i class="fa-solid fa-pen text-lg"></i></button>
                        <button onclick="deleteRow('premiums', ${p.id})" class="text-rose-500 hover:text-rose-700 p-1 hover:bg-rose-50 rounded" title="Delete"><i class="fa-solid fa-trash text-lg"></i></button>
                    </td>
            `;
        tbody.appendChild(tr);
    });
}

document.getElementById('premiumForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const dueDate = document.getElementById('premDueDate').value;
    const paidDate = document.getElementById('premPaidDate').value;
    const amount = parseFormattedNumber(document.getElementById('premAmount').value);
    const policyYear = parseInt(document.getElementById('premPolicyYear').value);

    try {
        const payload = {
            policyYear,
            dueDate,
            paidDate,
            amount,
            timestamp: Date.now()
        };

        if (editingPremiumId) {
            await db.premiums.update(editingPremiumId, payload);
            Swal.fire({ title: 'Record Updated', icon: 'success', timer: 1500, showConfirmButton: false });
        } else {
            payload.syncId = Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
            await db.premiums.add(payload);
            Swal.fire({ title: 'Premium Recorded', icon: 'success', timer: 1500, showConfirmButton: false });
        }

        cancelEdit('premiums');
        initApp(); // Refresh dashboard totals and auto-calc next due date / amount
        renderPremiumsTable();
        if (typeof autoSyncToCloud === 'function') autoSyncToCloud();
    } catch (err) {
        Swal.fire('Error', 'Could not save premium record', 'error');
    }
});


// --- 7. DYNAMIC SETTINGS UI MODIFICATIONS ---
function populateSettingsForm() {
    document.getElementById('setHolderName').value = config.policyName;
    document.getElementById('setHolderAge').value = config.policyAge || '';
    document.getElementById('setHolderNIC').value = config.policyNIC || '';
    document.getElementById('setPolicyNo').value = config.policyNo;
    document.getElementById('setPolicyTerm').value = config.policyTerm ? config.policyTerm.toLocaleString('en-US') : '';
    document.getElementById('setMonthlyPremium').value = config.monthlyPremium ? config.monthlyPremium.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';

    if (document.getElementById('setPremiumFrequency')) document.getElementById('setPremiumFrequency').value = config.premiumFrequency || 'Monthly';

    if (document.getElementById('setActiveDate')) document.getElementById('setActiveDate').value = config.activeDate || '';
    document.getElementById('setBaseCover').value = config.baseCover ? config.baseCover.toLocaleString('en-US') : '';
    document.getElementById('setCriticalCover').value = config.criticalCover ? config.criticalCover.toLocaleString('en-US') : '';
    document.getElementById('setHospitalPerDay').value = config.hospitalPerDay ? config.hospitalPerDay.toLocaleString('en-US') : '';
    if (document.getElementById('setHospitalRoomPct')) document.getElementById('setHospitalRoomPct').value = config.hospitalRoomPct || 2.0;

    if (document.getElementById('setOverdueRiskDays')) document.getElementById('setOverdueRiskDays').value = config.overdueRiskDays !== undefined ? config.overdueRiskDays : 26;
    if (document.getElementById('setNoClaimBonusPct')) document.getElementById('setNoClaimBonusPct').value = config.noClaimBonusPct !== undefined ? config.noClaimBonusPct : 25;
    if (document.getElementById('setAppPin')) document.getElementById('setAppPin').value = config.appPin || '';

    const savedUrl = localStorage.getItem('googleWebAppUrl');
    if (savedUrl && document.getElementById('googleWebAppUrl')) {
        document.getElementById('googleWebAppUrl').value = savedUrl;
    }

    // Build Dynamic Inner Limit Fields in Settings
    renderInnerLimitFields();
    renderPolicyDocs();
}

function renderInnerLimitFields() {
    const container = document.getElementById('innerLimitsContainer');
    container.innerHTML = '';
    for (const [name, target] of Object.entries(config.innerLimits)) {
        addInnerLimitDOM(name, target.pct, target.icon);
    }
}

function addInnerLimitField() {
    Swal.fire({
        title: 'New Sub-Category',
        html: `
                    <style>
                        .swal-ic-option { display: flex; align-items: center; gap: 10px; padding: 10px; }
                        #swal-input-name { width: 80%; padding: 10px; margin-bottom: 10px; border: 1px solid #ccc; border-radius: 5px; font-size: 14px; }
                        #swal-input-icon { width: 80%; padding: 10px; border: 1px solid #ccc; border-radius: 5px; font-size: 14px; }
                    </style>
                    <input id="swal-input-name" placeholder="Name (e.g., Maternity, Therapy)" />
                    <select id="swal-input-icon">
                        <option value="fa-stethoscope text-green-500">Stethoscope (General)</option>
                        <option value="fa-glasses text-teal-500">Glasses (Optical)</option>
                        <option value="fa-tooth text-cyan-500">Tooth (Dental)</option>
                        <option value="fa-baby text-pink-500">Baby (Maternity)</option>
                        <option value="fa-ear-listen text-orange-500">Ear (Hearing)</option>
                        <option value="fa-crutch text-purple-500">Mobility (Therapy)</option>
                        <option value="fa-user-nurse text-rose-500">Nurse (Care)</option>
                        <option value="fa-pills text-blue-500">Pills (Pharmacy)</option>
                        <option value="fa-heart-pulse text-red-500">Heart (Cardio)</option>
                        <option value="fa-kit-medical text-amber-500">Medical Kit (Other)</option>
                    </select>
                `,
        showCancelButton: true,
        focusConfirm: false,
        preConfirm: () => {
            const name = document.getElementById('swal-input-name').value.trim();
            const icon = document.getElementById('swal-input-icon').value;
            if (!name) { Swal.showValidationMessage('Name is required!'); return false; }
            if (name === 'General Claim' || name === 'Hospital Room' || name === 'Critical Illness') { Swal.showValidationMessage('Reserved category name'); return false; }
            if (config.innerLimits[name] !== undefined) { Swal.showValidationMessage('Category already exists'); return false; }
            return { name, icon };
        }
    }).then((result) => {
        if (result.isConfirmed) {
            config.innerLimits[result.value.name] = { pct: 1.0, icon: result.value.icon };
            addInnerLimitDOM(result.value.name, 1.0, result.value.icon);
            document.getElementById('settingsForm').dispatchEvent(new Event('submit'));
        }
    });
}

function removeInnerLimit(name) {
    delete config.innerLimits[name];
    document.getElementById(`il-wrapper-${name.replace(/\s+/g, '-')}`).remove();
}

function addInnerLimitDOM(name, value, icon) {
    const safeId = name.replace(/\s+/g, '-');
    const el = document.createElement('div');
    el.id = `il-wrapper-${safeId}`;
    el.className = 'bg-white border text-sm border-slate-200 p-2 rounded relative flex items-center justify-between shadow-sm';
    el.innerHTML = `
                <div class="flex-1 min-w-0 pr-2">
                    <label class="block font-semibold text-slate-700 truncate mb-1" title="${name}"><i class="fa-solid ${icon} mr-1 opacity-80"></i> ${name}</label>
                    <div class="flex">
                        <input type="number" step="0.1" required class="il-input w-full bg-slate-50 rounded-l border border-slate-300 px-2 py-1" data-name="${name}" data-icon="${icon}" value="${value}">
                        <span class="bg-slate-100 text-slate-500 border border-l-0 border-slate-300 rounded-r px-2 py-1">%</span>
                    </div>
                </div>
                <button type="button" onclick="removeInnerLimit('${name}')" class="text-rose-400 hover:text-rose-600 bg-rose-50 h-8 w-8 rounded shrink-0 flex items-center justify-center"><i class="fa-solid fa-xmark"></i></button>
            `;
    document.getElementById('innerLimitsContainer').appendChild(el);
}

document.getElementById('settingsForm').addEventListener('submit', (e) => {
    e.preventDefault();

    // Gather all inner limits from DOM
    let newInnerLimits = {};
    document.querySelectorAll('.il-input').forEach(input => {
        newInnerLimits[input.dataset.name] = { pct: parseFloat(input.value), icon: input.dataset.icon };
    });

    let newPin = document.getElementById('setAppPin') ? document.getElementById('setAppPin').value.trim() : "";
    let oldPin = config.appPin;

    config = {
        policyName: document.getElementById('setHolderName').value.trim(),
        policyAge: parseInt(document.getElementById('setHolderAge').value) || null,
        policyNIC: document.getElementById('setHolderNIC').value.trim(),
        policyNo: document.getElementById('setPolicyNo').value.trim(),
        policyTerm: parseFormattedNumber(document.getElementById('setPolicyTerm').value),
        monthlyPremium: parseFormattedNumber(document.getElementById('setMonthlyPremium').value),
        premiumFrequency: document.getElementById('setPremiumFrequency') ? document.getElementById('setPremiumFrequency').value : 'Monthly',
        activeYear: config.activeYear,
        activeDate: document.getElementById('setActiveDate') ? document.getElementById('setActiveDate').value : "",
        baseCover: parseFormattedNumber(document.getElementById('setBaseCover').value),
        criticalCover: parseFormattedNumber(document.getElementById('setCriticalCover').value),
        hospitalPerDay: parseFormattedNumber(document.getElementById('setHospitalPerDay').value),
        hospitalRoomPct: parseFloat(document.getElementById('setHospitalRoomPct').value) || 2.0,
        overdueRiskDays: parseInt(document.getElementById('setOverdueRiskDays') ? document.getElementById('setOverdueRiskDays').value : 26) || 26,
        noClaimBonusPct: parseFloat(document.getElementById('setNoClaimBonusPct') ? document.getElementById('setNoClaimBonusPct').value : 25) || 25,
        appPin: newPin,
        innerLimits: newInnerLimits // Assigned Dynamic limits
    };

    saveConfig();

    if (newPin && newPin !== oldPin) {
        Swal.fire({ title: 'PIN Saved!', text: 'Your App Lock PIN has been updated.', icon: 'success' });
    } else {
        Swal.fire({ title: 'Saved', icon: 'success', timer: 1000, showConfirmButton: false });
    }

    initApp();
});


// --- POLICY DOCS ---
async function renderPolicyDocs() {
    const gallery = document.getElementById('policyDocsGallery');
    if (!gallery) return;
    gallery.innerHTML = '';

    const docs = await db.policyDocs.toArray();
    if (docs.length === 0) {
        gallery.innerHTML = '<div class="col-span-full text-center text-slate-400 text-sm italic py-4">No documents uploaded yet.</div>';
        return;
    }

    docs.forEach(doc => {
        let previewHtml = '';
        if (doc.type.startsWith('image/')) {
            previewHtml = `<img src="${doc.data}" class="w-full h-24 object-cover rounded-t-lg border-b border-indigo-100" />`;
        } else {
            previewHtml = `<div class="w-full h-24 bg-indigo-50 flex flex-col items-center justify-center rounded-t-lg border-b border-indigo-100"><i class="fa-solid fa-file-pdf text-rose-400 text-3xl mb-1"></i><span class="text-[10px] text-indigo-400 font-bold uppercase">PDF</span></div>`;
        }

        const el = document.createElement('div');
        el.className = 'bg-white border text-sm border-indigo-100 rounded-lg shadow-sm flex flex-col relative group overflow-hidden';
        el.innerHTML = `
            ${previewHtml}
            <div class="px-2 py-2 flex justify-between items-center gap-2">
                <span class="text-[10px] text-slate-600 font-medium truncate flex-1" title="${doc.name}">${doc.name}</span>
                <button type="button" onclick="viewDocument('${doc.data}', '${doc.type}')" class="text-indigo-500 hover:text-indigo-700 mx-1 shrink-0" title="View"><i class="fa-solid fa-eye text-sm"></i></button>
            </div>
            <button type="button" onclick="deleteRow('policyDocs', ${doc.id})" class="absolute top-1 right-1 bg-white hover:bg-rose-50 border border-slate-200 text-rose-500 rounded-full w-6 h-6 flex items-center justify-center opacity-0 group-hover:opacity-100 transition shadow-sm"><i class="fa-solid fa-xmark text-xs"></i></button>
        `;
        gallery.appendChild(el);
    });
}

function uploadPolicyDocs() {
    const input = document.getElementById('policyDocsInput');
    const files = input.files;

    if (files.length === 0) {
        Swal.fire('No Files', 'Please select at least one file to upload.', 'warning');
        return;
    }

    Swal.fire({ title: 'Uploading...', allowOutsideClick: false, didOpen: () => { Swal.showLoading(); } });

    let processed = 0;
    Array.from(files).forEach(file => {
        const reader = new FileReader();
        reader.onload = async () => {
            await db.policyDocs.add({
                name: file.name,
                type: file.type,
                data: reader.result,
                timestamp: Date.now()
            });
            processed++;
            if (processed === files.length) {
                input.value = '';
                Swal.fire('Uploaded', 'Documents saved to policy config.', 'success');
                renderPolicyDocs();
            }
        };
        reader.onerror = () => {
            console.error("Error reading file");
            processed++;
            if (processed === files.length) renderPolicyDocs();
        };
        reader.readAsDataURL(file);
    });
}


// --- REPORT TAB & CHART JS ---
let chart1, chart2, chart3, chart4;
async function renderReportTab() {
    const allClaims = await db.claims.toArray();
    const allPrems = await db.premiums.toArray();
    let sumC = 0, sumP = 0, yrClaimData = {}, yrPremData = {}, catData = {};

    allClaims.forEach(c => {
        let a = parseFloat(c.amount);
        let cashBenefit = 0;
        if (c.category === 'Hospital Room' && c.days && c.days > 2) {
            cashBenefit = (c.days * config.hospitalPerDay);
        }

        let totalVal = a + cashBenefit;
        sumC += totalVal;
        yrClaimData[c.policyYear] = (yrClaimData[c.policyYear] || 0) + totalVal;

        catData[c.category] = (catData[c.category] || 0) + a;
        if (cashBenefit > 0) {
            catData['Hospital Cash Benefit'] = (catData['Hospital Cash Benefit'] || 0) + cashBenefit;
        }
    });
    allPrems.forEach(p => {
        let a = parseFloat(p.amount);
        sumP += a;
        yrPremData[p.policyYear] = (yrPremData[p.policyYear] || 0) + a;
    });

    document.getElementById('repTotalPaid').innerText = formatRs(sumP);
    document.getElementById('repTotalClaimed').innerText = formatRs(sumC);

    let claimRatio = sumP > 0 ? (sumC / sumP) * 100 : 0;

    const rEl = document.getElementById('repRoiValue');
    rEl.innerText = `${claimRatio.toFixed(1)}%`;
    rEl.className = claimRatio > 0 ? 'text-4xl font-black text-purple-900 mt-2' : 'text-4xl font-black text-slate-800 mt-2';

    if (chart1) chart1.destroy(); if (chart2) chart2.destroy(); if (chart3) chart3.destroy(); if (chart4) chart4.destroy();

    let catLabels = Object.keys(catData);
    let catVals = Object.values(catData);
    if (catLabels.length === 0) {
        catLabels = ['No Claims Yet'];
        catVals = [1];
    }

    chart1 = new Chart(document.getElementById('roiPieChart'), {
        type: 'doughnut',
        data: {
            labels: catLabels,
            datasets: [{
                data: catVals,
                backgroundColor: ['#14b8a6', '#8b5cf6', '#f59e0b', '#ec4899', '#3b82f6', '#ef4444', '#10b981'],
                borderColor: '#ffffff',
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        font: { family: 'Inter', size: 11 },
                        boxWidth: 12,
                        padding: 15
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            if (catLabels[0] === 'No Claims Yet') return ' No Claims';
                            return ' Rs. ' + context.raw.toLocaleString('en-US', { minimumFractionDigits: 2 });
                        }
                    }
                }
            }
        }
    });

    let lbl = [], cD = [], pD = [];
    for (let i = 1; i <= config.activeYear; i++) {
        lbl.push(`Yr ${i}`);
        cD.push(yrClaimData[i] || 0);
        pD.push(yrPremData[i] || 0);
    }
    chart2 = new Chart(document.getElementById('yearBarChart'), {
        type: 'bar',
        data: {
            labels: lbl,
            datasets: [
                { label: 'Paid (Rs)', data: pD, backgroundColor: '#3b82f6', borderRadius: 4 },
                { label: 'Claimed (Rs)', data: cD, backgroundColor: '#8b5cf6', borderRadius: 4 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    grid: { color: '#f1f5f9', drawBorder: false },
                    ticks: { font: { family: 'Inter' } }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: '#f1f5f9', drawBorder: false },
                    ticks: { font: { family: 'Inter' } }
                }
            },
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        font: { family: 'Inter', size: 11 },
                        boxWidth: 12,
                        padding: 15
                    }
                }
            }
        }
    });

    chart3 = new Chart(document.getElementById('catBarChart'), {
        type: 'bar',
        data: {
            labels: catLabels,
            datasets: [{
                label: 'Claimed (Rs)',
                data: catVals,
                backgroundColor: ['#14b8a6', '#8b5cf6', '#f59e0b', '#ec4899', '#3b82f6', '#ef4444', '#10b981'],
                borderRadius: 4
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    beginAtZero: true,
                    grid: { color: '#f1f5f9', drawBorder: false },
                    ticks: { font: { family: 'Inter' } }
                },
                y: {
                    grid: { color: '#f1f5f9', drawBorder: false },
                    ticks: { font: { family: 'Inter' } }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            if (catLabels[0] === 'No Claims Yet') return ' No Claims';
                            return ' Rs. ' + context.raw.toLocaleString('en-US', { minimumFractionDigits: 2 });
                        }
                    }
                }
            }
        }
    });

    chart4 = new Chart(document.getElementById('yearPieChart'), {
        type: 'pie',
        data: {
            labels: ['Total Paid Premium', 'Total Claimed Benefits'],
            datasets: [{
                data: [sumP, sumC],
                backgroundColor: ['#3b82f6', '#8b5cf6'],
                borderColor: '#ffffff',
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        font: { family: 'Inter', size: 11 },
                        boxWidth: 12,
                        padding: 15
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            return ' Rs. ' + context.raw.toLocaleString('en-US', { minimumFractionDigits: 2 });
                        }
                    }
                }
            }
        }
    });

    await renderBenefitsReport();
}

async function renderBenefitsReport() {
    const container = document.getElementById('benefitsReportContainer');
    if (!container) return;

    container.innerHTML = '<div class="text-center text-slate-500 py-4"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Loading report...</div>';

    const allClaims = await db.claims.toArray();

    let yearlyData = {};
    let grandTotal = { Overall: 0, Critical: 0, HospitalBenefit: 0, Inner: {} };
    for (let cat in config.innerLimits) grandTotal.Inner[cat] = 0;

    allClaims.forEach(req => {
        let yr = req.policyYear || 1;
        if (!yearlyData[yr]) {
            yearlyData[yr] = { Overall: 0, Critical: 0, HospitalBenefit: 0, Inner: {} };
            for (let c in config.innerLimits) yearlyData[yr].Inner[c] = 0;
        }

        let amt = parseFloat(req.amount) || 0;

        if (req.category === 'Critical Illness') {
            yearlyData[yr].Critical += amt;
            grandTotal.Critical += amt;
        } else if (req.category === 'Hospital Room') {
            yearlyData[yr].Overall += amt;
            grandTotal.Overall += amt;
            if (req.days && req.days > 2) {
                let hb = req.days * config.hospitalPerDay;
                yearlyData[yr].HospitalBenefit += hb;
                grandTotal.HospitalBenefit += hb;
            }
        } else {
            yearlyData[yr].Overall += amt;
            grandTotal.Overall += amt;
            if (config.innerLimits[req.category] !== undefined) {
                if (yearlyData[yr].Inner[req.category] === undefined) yearlyData[yr].Inner[req.category] = 0;
                yearlyData[yr].Inner[req.category] += amt;
                if (grandTotal.Inner[req.category] === undefined) grandTotal.Inner[req.category] = 0;
                grandTotal.Inner[req.category] += amt;
            } else {
                if (yearlyData[yr].Inner[req.category] === undefined) yearlyData[yr].Inner[req.category] = 0;
                yearlyData[yr].Inner[req.category] += amt;
                if (grandTotal.Inner[req.category] === undefined) grandTotal.Inner[req.category] = 0;
                grandTotal.Inner[req.category] += amt;
            }
        }
    });

    let html = '';

    const renderBlock = (title, data, isGrandTotal = false) => {
        let blockTotal = data.Overall + data.Critical + data.HospitalBenefit;
        if (blockTotal === 0 && !isGrandTotal) return '';

        let headerColor = isGrandTotal ? 'bg-indigo-600 text-white' : 'bg-slate-50 text-slate-800 border-b border-slate-100';
        let titleOpacity = isGrandTotal ? 'text-amber-300' : 'text-brand-500';
        let titleClass = isGrandTotal ? 'text-lg font-black' : 'text-base font-bold text-slate-700';
        let amountClass = isGrandTotal ? 'text-white' : 'text-brand-600';
        let subTextClass = isGrandTotal ? 'opacity-80' : 'text-slate-500';
        let boxBorderClass = isGrandTotal ? 'border border-indigo-200 shadow-md shadow-indigo-100' : 'border border-slate-100 shadow-sm';

        let innerHtml = '';
        const innerKeys = Object.keys(data.Inner).filter(k => data.Inner[k] > 0);

        let internalBoxesHtml = '';

        if (data.Overall > 0) {
            internalBoxesHtml += `
            <div class="flex items-center gap-3 p-3 rounded-lg border border-blue-50 bg-white shadow-sm hover:shadow-md transition">
                <div class="bg-blue-50 p-2 rounded-md flex items-center justify-center w-8 h-8"><i class="fa-solid fa-umbrella text-blue-500 text-sm"></i></div>
                <div>
                    <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-px">Overall Cover</p>
                    <h5 class="text-base font-black text-slate-800">${formatRs(data.Overall)}</h5>
                </div>
            </div>`;
        }

        if (data.Critical > 0) {
            internalBoxesHtml += `
            <div class="flex items-center gap-3 p-3 rounded-lg border border-rose-50 bg-white shadow-sm hover:shadow-md transition">
                <div class="bg-rose-50 p-2 rounded-md flex items-center justify-center w-8 h-8"><i class="fa-solid fa-heart-pulse text-rose-500 text-sm"></i></div>
                <div>
                    <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-px">Critical Illness</p>
                    <h5 class="text-base font-black text-slate-800">${formatRs(data.Critical)}</h5>
                </div>
            </div>`;
        }

        if (data.HospitalBenefit > 0) {
            internalBoxesHtml += `
            <div class="flex items-center gap-3 p-3 rounded-lg border border-purple-50 bg-white shadow-sm hover:shadow-md transition">
                <div class="bg-purple-50 p-2 rounded-md flex items-center justify-center w-8 h-8"><i class="fa-solid fa-bed-pulse text-purple-500 text-sm"></i></div>
                <div>
                    <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-px">Hospital Cash</p>
                    <h5 class="text-base font-black text-slate-800">${formatRs(data.HospitalBenefit)}</h5>
                </div>
            </div>`;
        }

        innerKeys.forEach(cat => {
            let userIconData = config.innerLimits[cat] ? config.innerLimits[cat].icon : 'fa-tag text-slate-500';
            let iClass = userIconData.includes(' ') ? userIconData.split(' ')[0] : userIconData;
            let colorCls = userIconData.includes(' ') ? userIconData.split(' ')[1] : 'text-slate-500';
            let bgCls = colorCls.replace('text-', 'bg-').replace('500', '50');
            if (bgCls === colorCls) bgCls = 'bg-slate-50'; // fallback

            internalBoxesHtml += `
            <div class="flex items-center gap-3 p-3 rounded-lg border border-slate-50 bg-white shadow-sm hover:shadow-md transition">
                <div class="${bgCls} p-2 rounded-md flex items-center justify-center w-8 h-8">
                    <i class="fa-solid ${iClass} ${colorCls} text-sm"></i>
                </div>
                <div>
                    <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-px">${cat}</p>
                    <h5 class="text-base font-black text-slate-800">${formatRs(data.Inner[cat])}</h5>
                </div>
            </div>`;
        });

        let emptyState = blockTotal === 0 ? '<div class="col-span-1 sm:col-span-2 lg:col-span-4 text-center py-4 text-slate-400 text-sm">No benefits recorded.</div>' : '';

        return `
        <div class="rounded-lg overflow-hidden mb-4 ${boxBorderClass}">
            <div class="${headerColor} p-3 md:p-4 flex flex-col md:flex-row md:justify-between md:items-center gap-2">
                <h4 class="${titleClass} flex items-center gap-2">
                    ${isGrandTotal ? '<i class="fa-solid fa-trophy text-amber-300 text-lg"></i>' : '<div class="bg-brand-100 p-1.5 rounded block"><i class="fa-solid fa-calendar text-brand-600 text-sm"></i></div>'}
                    ${title}
                </h4>
                <div class="md:text-right border-t md:border-0 pt-2 md:pt-0 ${isGrandTotal ? 'border-indigo-400' : 'border-slate-200'}">
                    <span class="text-[9px] uppercase tracking-widest font-bold ${subTextClass} block mb-0.5">Total For ${isGrandTotal ? 'Policy' : 'Year'}</span>
                    <span class="text-xl font-black ${amountClass} block leading-none">${formatRs(blockTotal)}</span>
                </div>
            </div>
            
            <div class="p-3 bg-slate-50/50">
                <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                    ${internalBoxesHtml}
                    ${emptyState}
                </div>
            </div>
        </div>
        `;
    };

    // Check if we have data at all
    const yrs = Object.keys(yearlyData).map(Number).sort((a, b) => b - a);
    if (grandTotal.Overall + grandTotal.Critical + grandTotal.HospitalBenefit === 0) {
        container.innerHTML = `<div class="p-8 text-center bg-white text-slate-400 border border-slate-100 rounded-xl shadow-sm"><i class="fa-solid fa-folder-open text-4xl mb-3 opacity-30 block"></i> No utilization data available to generate report.</div>`;
        return;
    }

    // First do Grand Total
    html += renderBlock('Grand Total (All Time)', grandTotal, true);

    // Then Each Year
    yrs.forEach(y => {
        html += renderBlock(`Policy Year ${y}`, yearlyData[y], false);
    });

    container.innerHTML = html;
}


// --- MISC UTILS ---
async function editRow(store, id) {
    const record = await db[store].get(id);
    if (!record) return;

    if (store === 'claims') {
        editingClaimId = id;
        document.getElementById('claimDate').value = record.date;
        document.getElementById('claimCategory').value = record.category;
        toggleDaysInput();
        if (record.days) document.getElementById('claimDays').value = record.days;
        document.getElementById('claimAmount').value = parseFloat(record.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        document.getElementById('claimHospital').value = record.hospital;
        document.getElementById('claimDescription').value = record.description || '';
        document.getElementById('claimSubmitBtn').innerHTML = '<i class="fa-solid fa-pen mr-1"></i> Update Claim';
        document.getElementById('claimCancelBtn').classList.remove('hidden');
        document.getElementById('claimDate').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (store === 'premiums') {
        editingPremiumId = id;
        document.getElementById('premAmount').value = parseFloat(record.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        document.getElementById('premDueDate').value = record.dueDate;
        document.getElementById('premPaidDate').value = record.paidDate;
        document.getElementById('premPolicyYear').value = record.policyYear;
        document.getElementById('premSubmitBtn').innerHTML = '<i class="fa-solid fa-pen mr-1"></i> Update Record';
        document.getElementById('premCancelBtn').classList.remove('hidden');
        document.getElementById('premAmount').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function cancelEdit(store) {
    if (store === 'claims') {
        editingClaimId = null;
        document.getElementById('claimForm').reset();
        toggleDaysInput();
        document.getElementById('claimDate').valueAsDate = new Date();
        document.getElementById('claimSubmitBtn').innerHTML = '<i class="fa-solid fa-plus mr-1"></i> Save Claim';
        document.getElementById('claimCancelBtn').classList.add('hidden');
    } else if (store === 'premiums') {
        editingPremiumId = null;
        document.getElementById('premiumForm').reset();
        document.getElementById('premPaidDate').valueAsDate = new Date();
        document.getElementById('premPolicyYear').value = config.activeYear;
        document.getElementById('premSubmitBtn').innerHTML = '<i class="fa-solid fa-check mr-1"></i> Save Record';
        document.getElementById('premCancelBtn').classList.add('hidden');
        calculateNextPremium();
    }
}

async function deleteRow(store, id) {
    if ((await Swal.fire({ title: 'Delete?', icon: 'warning', showCancelButton: true })).isConfirmed) {
        await db[store].delete(id);
        if (store === 'policyDocs') {
            renderPolicyDocs();
        } else {
            initApp();
            if (store === 'claims') {
                if (typeof renderClaimsTable === 'function') renderClaimsTable();
            }
            if (store === 'premiums') {
                if (typeof renderPremiumsTable === 'function') renderPremiumsTable();
            }
            if (typeof autoSyncToCloud === 'function') autoSyncToCloud();
        }
    }
}
function viewDocument(data, type) {
    document.getElementById('modalContent').innerHTML = type.startsWith('image') ? `<img src="${data}" class="max-h-full max-w-full rounded">` : `<iframe src="${data}" class="w-full h-[60vh]"></iframe>`;
    document.getElementById('documentModal').classList.remove('hidden');
}
function closeModal() { document.getElementById('documentModal').classList.add('hidden'); }
async function resetData() {
    if ((await Swal.fire({ title: 'Factory Reset?', html: 'Wipes ALL claims, premium records, and policy documents!', icon: 'error', showCancelButton: true, confirmButtonColor: '#e11d48' })).isConfirmed) {
        await db.claims.clear();
        await db.premiums.clear();
        await db.policyDocs.clear();
        config = DEFAULT_CONFIG; saveConfig(); initApp(); switchTab('dashboard');
        Swal.fire('Cleared', '', 'success');
    }
}

async function exportData() {
    try {
        const claimsData = await db.claims.toArray();
        const premiumsData = await db.premiums.toArray();
        const policyDocsData = await db.policyDocs.toArray();

        const backup = {
            metadata: {
                timestamp: new Date().toISOString(),
                version: '3.0'
            },
            config: config,
            claims: claimsData,
            premiums: premiumsData,
            policyDocs: policyDocsData
        };

        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(backup));
        const downloadAnchorNode = document.createElement('a');
        let curDate = new Date().toISOString().split('T')[0];
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", `InsuranceBackup_${curDate}.json`);
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();

        Swal.fire('Exported!', 'Backup file has been downloaded successfully.', 'success');
    } catch (err) {
        console.error(err);
        Swal.fire('Export Error', 'Failed to generate backup.', 'error');
    }
}

async function importData() {
    const fileInput = document.getElementById('importFile');
    const file = fileInput.files[0];

    if (!file) return Swal.fire('Error', 'Please select a backup JSON file to import.', 'error');

    const confirmed = await Swal.fire({
        title: 'Are you sure?',
        text: 'This will completely replace your current system data with the backup!',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33'
    });

    if (confirmed.isConfirmed) {
        Swal.fire({ title: 'Restoring...', allowOutsideClick: false, didOpen: () => { Swal.showLoading(); } });
        const reader = new FileReader();
        reader.onload = async function (e) {
            try {
                const parsedData = JSON.parse(e.target.result);

                if (!parsedData.config) throw new Error("Invalid backup format");

                await db.claims.clear();
                await db.premiums.clear();
                await db.policyDocs.clear();

                if (parsedData.claims && parsedData.claims.length > 0) {
                    await db.claims.bulkAdd(parsedData.claims);
                }

                if (parsedData.premiums && parsedData.premiums.length > 0) {
                    await db.premiums.bulkAdd(parsedData.premiums);
                }

                if (parsedData.policyDocs && parsedData.policyDocs.length > 0) {
                    await db.policyDocs.bulkAdd(parsedData.policyDocs);
                }

                config = parsedData.config;
                localStorage.setItem('policyConfig', JSON.stringify(config));

                fileInput.value = ""; // clear input

                Swal.fire('Restored!', 'System data has been successfully imported.', 'success').then(() => {
                    window.location.reload(); // Reload to apply all restored states safely
                });

            } catch (err) {
                console.error(err);
                Swal.fire('Import Error', 'Failed to read or process the backup file. It might be corrupted or incompatible.', 'error');
            }
        };
        reader.readAsText(file);
    }
}

// --- CLOUD SYNC FUNCTIONS ---
function showCloudSyncInfo() {
    Swal.fire({
        title: 'පද්ධතිය ක්‍රියාත්මක වන ආකාරය (Architecture)',
        html: `
            <div class="text-left text-sm text-slate-700 space-y-3 font-sans leading-relaxed">
                <p>මෙම පද්ධතිය ප්‍රධාන වශයෙන් කොටස් දෙකකින් යුක්ත වන අතර, එය අන්තර්ජාලය නොමැති අවස්ථාවලදී පවා බාධාවකින් තොරව ක්‍රියා කිරීමට සැලසුම් කර ඇත.</p>
                
                <div class="bg-slate-50 p-2 rounded border border-slate-100">
                    <strong class="text-indigo-800 block mb-1"><i class="fa-solid fa-server mr-1"></i> 1. Offline පළමු ප්‍රතිපත්තිය (Local First)</strong>
                    <p class="text-xs">පද්ධතියට ඇතුළත් කරන සියලුම Claims සහ Premium දත්ත ප්‍රථමයෙන් පරිශීලකයාගේ Browser එක තුළ ඇති IndexedDB දත්ත ගබඩාවේ සුරැකේ. මේ නිසා අන්තර්ජාලය නොමැති වුවද දත්ත ඇතුළත් කිරීමට සහ කළමනාකරණය කිරීමට බාධාවක් නොවේ.</p>
                </div>

                <div class="bg-slate-50 p-2 rounded border border-slate-100">
                    <strong class="text-indigo-800 block mb-1"><i class="fa-solid fa-rotate mr-1"></i> 2. Google Sheets සමඟ දත්ත සමමුහුර්තකරණය</strong>
                    <ul class="list-disc pl-5 mt-1 text-xs space-y-1">
                        <li><strong>Duplicate වැළැක්වීම:</strong> සෑම වාර්තාවකටම ලබා දී ඇති සුවිශේෂී අංකය (Unique ID) පරීක්ෂා කරනු ලැබේ. Google Sheet එකේ දැනටමත් පවතින දත්ත මඟ හැර, අලුතින් වූ දත්ත පමණක් (Incremental Sync) යැවීමට පද්ධතිය සකස් කළ හැකිය.</li>
                        <li><strong>දත්ත ආරක්ෂාව:</strong> අන්තර්ජාලය ඇති සැණින් ක්‍රියාත්මක වන Auto Sync පහසුකම හරහා Browser එකේ ඇති දත්ත ස්වයංක්‍රීයව සමපාත වේ.</li>
                    </ul>
                </div>

                <div class="bg-slate-50 p-2 rounded border border-slate-100">
                    <strong class="text-indigo-800 block mb-1"><i class="fa-solid fa-image mr-1"></i> 3. රූප රාමු සහ ලේඛන හැසිරවීම (Images/Docs)</strong>
                    <ul class="list-disc pl-5 text-xs space-y-1">
                        <li><strong>Google Sheet සීමාවන්:</strong> එක කොටුවක තැන්පත් කළ හැකි ප්‍රමාණය සීමිත බැවින්, පින්තූරවල "Base64 string" එක Cloud එකට යැවීමේදී ඉවත් කරනු ලැබේ.</li>
                        <li><strong>සුරැකීම:</strong> පින්තූර සහ PDF ලේඛන ඔබේ Browser එකේ පමණක් පවතින අතර, Cloud එකට යැවෙන්නේ විස්තර (Text) පමණි. රූප රාමු සමඟම සුරැකීමට 'JSON Backup' පහසුකම භාවිතා කරන්න.</li>
                    </ul>
                </div>
            </div>
        `,
        width: '600px',
        confirmButtonText: 'තේරුම්ගත්තා (Got it)',
        confirmButtonColor: '#4f46e5'
    });
}

async function syncToCloud() {
    const url = document.getElementById('googleWebAppUrl').value.trim();
    if (!url) return Swal.fire('Error', 'Please enter your Google Web App URL first.', 'error');

    // Save URL to config so it persists
    localStorage.setItem('googleWebAppUrl', url);

    try {
        Swal.fire({ title: 'Syncing to Cloud...', html: 'Uploading your data safely...', allowOutsideClick: false, didOpen: () => { Swal.showLoading(); } });

        const claimsData = await db.claims.toArray();
        const premiumsData = await db.premiums.toArray();

        // Strip large base64 fileData from claims before sending to Google Sheets (limitations apply)
        const strippedClaims = claimsData.map(c => {
            const temp = { ...c };
            delete temp.fileData; // Do not send large string arrays to prevent Google Sheet from returning error
            delete temp.fileType;
            return temp;
        });

        const payload = {
            action: 'export',
            config: config,
            claims: strippedClaims,
            premiums: premiumsData
        };

        const response = await fetch(url, {
            method: 'POST',
            redirect: "follow",
            headers: { 'Content-Type': 'text/plain' }, // Text plain bypasses heavy CORS preflight
            body: JSON.stringify(payload)
        });

        const resData = await response.json();

        if (resData.status === 'success') {
            Swal.fire('Success!', 'Data successfully saved to your Google Sheet.', 'success');
        } else {
            Swal.fire('Error', 'Google Apps Script error: ' + (resData.message || 'Unknown'), 'error');
        }

    } catch (err) {
        console.error(err);
        Swal.fire('Network Error', 'Could not sync. Check your internet connection or the URL provided.', 'error');
    }
}

async function syncFromCloud() {
    const url = document.getElementById('googleWebAppUrl').value.trim();
    if (!url) return Swal.fire('Error', 'Please enter your Google Web App URL first.', 'error');

    localStorage.setItem('googleWebAppUrl', url);

    const confirmed = await Swal.fire({
        title: 'Restore from Cloud?',
        text: 'This will completely replace your CURRENT data (except policy PDF documents) with the data from your Google Sheet!',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33'
    });

    if (confirmed.isConfirmed) {
        Swal.fire({ title: 'Loading from Cloud...', allowOutsideClick: false, didOpen: () => { Swal.showLoading(); } });
        try {
            const response = await fetch(url, {
                method: 'GET',
                redirect: "follow"
            });

            const resData = await response.json();

            if (resData.status !== 'success' || !resData.data) {
                return Swal.fire('Error', 'Google Apps Script error: ' + (resData.message || 'Unknown. Make sure doGet is defined in script.'), 'error');
            }

            const parsedData = resData.data;

            // Optional: We do not clear policyDocs here, because we didn't send them to Cloud to save space!
            await db.claims.clear();
            await db.premiums.clear();

            // Helper to fix Google Sheets converting Date objects to ISO strings with Timezone offsets
            const formatSheetDate = (dStr) => {
                if (!dStr) return dStr;
                if (typeof dStr === 'string' && dStr.includes('T')) {
                    const d = new Date(dStr);
                    if (!isNaN(d)) return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
                }
                return dStr;
            };

            if (parsedData.claims && parsedData.claims.length > 0) {
                const fixedClaims = parsedData.claims.map(c => {
                    c.date = formatSheetDate(c.date);
                    return c;
                });
                await db.claims.bulkAdd(fixedClaims);
            }

            if (parsedData.premiums && parsedData.premiums.length > 0) {
                const fixedPremiums = parsedData.premiums.map(p => {
                    p.dueDate = formatSheetDate(p.dueDate);
                    p.paidDate = formatSheetDate(p.paidDate);
                    return p;
                });
                await db.premiums.bulkAdd(fixedPremiums);
            }

            if (parsedData.config) {
                config = parsedData.config;
                localStorage.setItem('policyConfig', JSON.stringify(config));
            }

            Swal.fire('Restored!', 'System data has been successfully imported from Google Sheet.', 'success').then(() => {
                window.location.reload();
            });

        } catch (err) {
            console.error(err);
            Swal.fire('Network Error', 'Could not sync from cloud. Check your connection or the URL.', 'error');
        }
    }
}

async function autoSyncToCloud() {
    const url = localStorage.getItem('googleWebAppUrl');
    if (!url) return;

    try {
        const claimsData = await db.claims.toArray();
        const premiumsData = await db.premiums.toArray();

        const strippedClaims = claimsData.map(c => {
            const temp = { ...c };
            delete temp.fileData;
            delete temp.fileType;
            return temp;
        });

        const payload = {
            action: 'export',
            config: config,
            claims: strippedClaims,
            premiums: premiumsData
        };

        fetch(url, {
            method: 'POST',
            redirect: "follow",
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify(payload)
        }).catch(err => console.error('Silent Auto Sync Error:', err));

    } catch (err) {
        console.error('Silent Auto Sync Error:', err);
    }
}

// Global Online Event Listener for Auto Sync when back online
window.addEventListener('online', () => {
    console.log("Back online, triggering auto sync to cloud in background...");
    if (typeof autoSyncToCloud === 'function') autoSyncToCloud();
});

// --- PDF EXPORT FUNCTIONS ---
// Helper to get PDF instance
function createPDFDoc() {
    const { jsPDF } = window.jspdf;
    return new jsPDF();
}

// PDF Helper: Apply Header & Footer common to all reports
function applyPDFHeaderFooter(doc, title) {
    const pageWidth = doc.internal.pageSize.width;

    // Header Background
    doc.setFillColor(15, 23, 42); // slate-900
    doc.rect(0, 0, pageWidth, 35, 'F');

    // Accent Line
    doc.setFillColor(13, 148, 136); // brand-600
    doc.rect(0, 35, pageWidth, 2, 'F');

    // Logo / Title
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(22);
    doc.setFont("helvetica", "bold");
    doc.text("Health Policy Monitor", 14, 20);

    doc.setFontSize(10);
    doc.setFont("helvetica", "italic");
    doc.setTextColor(203, 213, 225); // slate-300
    doc.text("Automated Health Insurance Tracking", 14, 27);

    // Document Title
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(13, 148, 136); // brand-600
    doc.text(title.toUpperCase(), 14, 50);

    // Holder details on right
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(255, 255, 255);
    doc.text(`Generated: ${new Date().toLocaleDateString()} `, pageWidth - 14, 18, { align: 'right' });
    doc.text(config.policyName ? `Holder: ${config.policyName} ` : 'Holder: N/A', pageWidth - 14, 25, { align: 'right' });
    doc.text(config.policyNo ? `Policy: ${config.policyNo} ` : 'Policy: N/A', pageWidth - 14, 30, { align: 'right' });

    return 58;
}

async function exportClaimsPDF() {
    const doc = createPDFDoc();
    let y = applyPDFHeaderFooter(doc, 'Claims History Report');

    const allClaims = await db.claims.reverse().sortBy('date');
    if (allClaims.length === 0) {
        doc.setTextColor(100);
        doc.text("No claims found in the system.", 14, y);
        doc.save(`Claims_Report_${config.policyName || 'System'}.pdf`);
        return;
    }

    let grandTotal = 0;
    let groupedClaims = {};

    allClaims.forEach(c => {
        if (!groupedClaims[c.policyYear]) groupedClaims[c.policyYear] = { rows: [], total: 0 };
        let catText = c.category;
        if (c.category === 'Hospital Room' && c.days) catText += ` (${c.days} Days)`;
        let rowAmount = parseFloat(c.amount) || 0;

        groupedClaims[c.policyYear].rows.push([
            c.date,
            `Year ${c.policyYear} `,
            catText,
            c.hospital,
            formatRs(c.amount)
        ]);
        groupedClaims[c.policyYear].total += rowAmount;
        grandTotal += rowAmount;
    });

    const tableData = [];
    // Sort years descending
    const yearsDesc = Object.keys(groupedClaims).sort((a, b) => b - a);

    yearsDesc.forEach(year => {
        tableData.push(...groupedClaims[year].rows);
        tableData.push([
            { content: `Total for Year ${year}`, colSpan: 4, styles: { halign: 'right', fontStyle: 'bold', fillColor: [241, 245, 249], textColor: [71, 85, 105], lineWidth: { top: 0.5, bottom: 0.5 }, lineColor: [203, 213, 225] } },
            { content: formatRs(groupedClaims[year].total), styles: { fontStyle: 'bold', fillColor: [241, 245, 249], textColor: [13, 148, 136], lineWidth: { top: 0.5, bottom: 0.5 }, lineColor: [203, 213, 225] } }
        ]);
        // Add a visual separator line / blank space
        tableData.push([
            { content: '', colSpan: 5, styles: { minCellHeight: 6, fillColor: [255, 255, 255] } }
        ]);
    });

    tableData.push([
        { content: 'GRAND TOTAL ALL TIME', colSpan: 4, styles: { halign: 'right', fontStyle: 'bold', fillColor: [226, 232, 240], textColor: [30, 41, 59], lineWidth: { top: 1, bottom: 1 }, lineColor: [148, 163, 184] } },
        { content: formatRs(grandTotal), styles: { fontStyle: 'bold', fillColor: [226, 232, 240], textColor: [15, 118, 110], lineWidth: { top: 1, bottom: 1 }, lineColor: [148, 163, 184] } }
    ]);

    doc.autoTable({
        startY: y,
        head: [['Date', 'Year', 'Category', 'Hospital / Desc', 'Amount']],
        body: tableData,
        theme: 'striped',
        headStyles: { fillColor: [71, 85, 105] }, // slate-600
        columnStyles: { 4: { halign: 'right', fontStyle: 'bold' } },
    });

    doc.save(`Claims_Report_${config.policyName || 'System'}.pdf`);
}

async function exportPremiumsPDF() {
    const doc = createPDFDoc();
    let y = applyPDFHeaderFooter(doc, 'Premium Payments Report');

    const allPrems = await db.premiums.reverse().sortBy('dueDate');
    if (allPrems.length === 0) {
        doc.setTextColor(100);
        doc.text("No premium payments found in the system.", 14, y);
        doc.save(`Premiums_Report_${config.policyName || 'System'}.pdf`);
        return;
    }

    let grandTotal = 0;
    let groupedPrems = {};

    allPrems.forEach(p => {
        if (!groupedPrems[p.policyYear]) groupedPrems[p.policyYear] = { rows: [], total: 0 };
        let rowAmount = parseFloat(p.amount) || 0;

        groupedPrems[p.policyYear].rows.push([
            p.dueDate,
            p.paidDate,
            `Year ${p.policyYear} `,
            formatRs(p.amount)
        ]);
        groupedPrems[p.policyYear].total += rowAmount;
        grandTotal += rowAmount;
    });

    const tableData = [];
    const yearsDesc = Object.keys(groupedPrems).sort((a, b) => b - a);

    yearsDesc.forEach(year => {
        tableData.push(...groupedPrems[year].rows);
        tableData.push([
            { content: `Total for Year ${year}`, colSpan: 3, styles: { halign: 'right', fontStyle: 'bold', fillColor: [241, 245, 249], textColor: [71, 85, 105], lineWidth: { top: 0.5, bottom: 0.5 }, lineColor: [191, 219, 254] } },
            { content: formatRs(groupedPrems[year].total), styles: { fontStyle: 'bold', fillColor: [241, 245, 249], textColor: [37, 99, 235], lineWidth: { top: 0.5, bottom: 0.5 }, lineColor: [191, 219, 254] } }
        ]);
        // Add a visual separator line / blank space
        tableData.push([
            { content: '', colSpan: 4, styles: { minCellHeight: 6, fillColor: [255, 255, 255] } }
        ]);
    });

    tableData.push([
        { content: 'GRAND TOTAL ALL TIME', colSpan: 3, styles: { halign: 'right', fontStyle: 'bold', fillColor: [226, 232, 240], textColor: [30, 41, 59], lineWidth: { top: 1, bottom: 1 }, lineColor: [148, 163, 184] } },
        { content: formatRs(grandTotal), styles: { fontStyle: 'bold', fillColor: [226, 232, 240], textColor: [29, 78, 216], lineWidth: { top: 1, bottom: 1 }, lineColor: [148, 163, 184] } }
    ]);

    doc.autoTable({
        startY: y,
        head: [['Due Date', 'Paid Date', 'Policy Year', 'Amount Paid']],
        body: tableData,
        theme: 'striped',
        headStyles: { fillColor: [59, 130, 246] }, // blue-500
        columnStyles: { 3: { halign: 'right', fontStyle: 'bold' } },
    });

    doc.save(`Premium_Payments_${config.policyName || 'System'}.pdf`);
}

async function exportSummaryPDF() {
    const doc = createPDFDoc();
    let y = applyPDFHeaderFooter(doc, 'Comprehensive Policy Summary');

    // Get data
    const allClaims = await db.claims.toArray();
    const allPrems = await db.premiums.toArray();

    let sumC = 0;
    allClaims.forEach(c => {
        let a = parseFloat(c.amount);
        if (c.category === 'Hospital Room' && c.days && c.days > 2) a += (c.days * config.hospitalPerDay);
        sumC += a;
    });
    let sumP = 0;
    allPrems.forEach(p => sumP += parseFloat(p.amount));

    let roi = sumP > 0 ? ((sumC - sumP) / sumP) * 100 : 0;
    if (sumP === 0 && sumC > 0) roi = 100;
    if (roi > 100) roi = 100;

    doc.setTextColor(30, 41, 59); // slate-800
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text("Financial Overview", 14, y);
    y += 10;

    doc.autoTable({
        startY: y,
        head: [['Metric', 'Value']],
        body: [
            ['Total Premium Paid', formatRs(sumP)],
            ['Total Claims & Benefits Enjoyed', formatRs(sumC)],
            ['Claim-to-Premium Ratio', `${roi > 0 ? '+' : ''}${roi.toFixed(1)}% `]
        ],
        theme: 'plain',
        styles: { fontSize: 11, cellPadding: 4 },
        headStyles: { fillColor: [241, 245, 249], textColor: [71, 85, 105] }, // slate-100/slate-600
        columnStyles: { 0: { fontStyle: 'bold' }, 1: { halign: 'right' } },
    });

    y = doc.lastAutoTable.finalY + 15;

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text("Policy Limits & Rules", 14, y);
    y += 10;

    const limitData = [
        ['Base Cover Limit', formatRs(config.baseCover)],
        ['Critical Illness Lifetime Limit', formatRs(config.criticalCover)],
        ['Hospital Cash Benefit (Per Day)', formatRs(config.hospitalPerDay)],
        ['Expected Monthly Premium', formatRs(config.monthlyPremium)],
        ['Policy Term', `${config.policyTerm} Years`]
    ];

    for (let key in config.innerLimits) {
        limitData.push([`${key} Limit(Custom)`, `${config.innerLimits[key].pct}% of Base Cover`]);
    }

    doc.autoTable({
        startY: y,
        head: [['Coverage Type', 'Limit Constraint']],
        body: limitData,
        theme: 'grid',
        headStyles: { fillColor: [13, 148, 136] }, // brand-600
        styles: { fontSize: 10 },
    });

    doc.save(`Policy_Summary_${config.policyName || 'System'}.pdf`);
}

async function exportBenefitsPDF() {
    const doc = createPDFDoc();
    let y = applyPDFHeaderFooter(doc, 'Benefits Enjoyed & Utilization');

    const allClaims = await db.claims.toArray();

    let yearlyData = {};
    let grandTotal = { Overall: 0, Critical: 0, HospitalBenefit: 0, Inner: {} };
    for (let cat in config.innerLimits) grandTotal.Inner[cat] = 0;

    allClaims.forEach(req => {
        let yr = req.policyYear || 1;
        if (!yearlyData[yr]) {
            yearlyData[yr] = { Overall: 0, Critical: 0, HospitalBenefit: 0, Inner: {} };
            for (let c in config.innerLimits) yearlyData[yr].Inner[c] = 0;
        }

        let amt = parseFloat(req.amount) || 0;

        if (req.category === 'Critical Illness') {
            yearlyData[yr].Critical += amt;
            grandTotal.Critical += amt;
        } else if (req.category === 'Hospital Room') {
            yearlyData[yr].Overall += amt;
            grandTotal.Overall += amt;
            if (req.days && req.days > 2) {
                let hb = req.days * config.hospitalPerDay;
                yearlyData[yr].HospitalBenefit += hb;
                grandTotal.HospitalBenefit += hb;
            }
        } else {
            yearlyData[yr].Overall += amt;
            grandTotal.Overall += amt;
            if (config.innerLimits[req.category] !== undefined) {
                if (yearlyData[yr].Inner[req.category] === undefined) yearlyData[yr].Inner[req.category] = 0;
                yearlyData[yr].Inner[req.category] += amt;
                if (grandTotal.Inner[req.category] === undefined) grandTotal.Inner[req.category] = 0;
                grandTotal.Inner[req.category] += amt;
            } else {
                if (yearlyData[yr].Inner[req.category] === undefined) yearlyData[yr].Inner[req.category] = 0;
                yearlyData[yr].Inner[req.category] += amt;
                if (grandTotal.Inner[req.category] === undefined) grandTotal.Inner[req.category] = 0;
                grandTotal.Inner[req.category] += amt;
            }
        }
    });

    if (grandTotal.Overall + grandTotal.Critical + grandTotal.HospitalBenefit === 0) {
        doc.setTextColor(100);
        doc.text("No utilization data available.", 14, y);
        doc.save(`Benefits_Report_${config.policyName || 'System'}.pdf`);
        return;
    }

    const renderDataToTable = (title, data, isGrandTotal) => {
        let blockTotal = data.Overall + data.Critical + data.HospitalBenefit;
        if (blockTotal === 0 && !isGrandTotal) return;

        if (y > doc.internal.pageSize.height - 40) {
            doc.addPage();
            y = 20;
        }

        doc.setFontSize(14);
        doc.setFont("helvetica", "bold");
        if (isGrandTotal) {
            doc.setTextColor(79, 70, 229); // indigo-600
        } else {
            doc.setTextColor(13, 148, 136); // brand-600
        }
        doc.text(title, 14, y);
        y += 6;

        let tableRows = [];
        if (data.Overall > 0) tableRows.push(['Overall Cover Benefits', formatRs(data.Overall)]);
        if (data.Critical > 0) tableRows.push(['Critical Illness Benefit', formatRs(data.Critical)]);
        if (data.HospitalBenefit > 0) tableRows.push(['Hospital Cash Benefit', formatRs(data.HospitalBenefit)]);

        const innerKeys = Object.keys(data.Inner).filter(k => data.Inner[k] > 0);
        innerKeys.forEach(cat => {
            tableRows.push([`${cat} Benefits`, formatRs(data.Inner[cat])]);
        });

        tableRows.push([
            { content: isGrandTotal ? 'GRAND TOTAL ALL TIME' : `Total For ${title}`, styles: { halign: 'right', fontStyle: 'bold', fillColor: isGrandTotal ? [224, 231, 255] : [241, 245, 249] } },
            { content: formatRs(blockTotal), styles: { fontStyle: 'bold', fillColor: isGrandTotal ? [224, 231, 255] : [241, 245, 249] } }
        ]);

        doc.autoTable({
            startY: y,
            head: [['Benefit Category', 'Amount Utilized']],
            body: tableRows,
            theme: 'grid',
            headStyles: { fillColor: isGrandTotal ? [79, 70, 229] : [15, 118, 110] },
            columnStyles: { 0: { fontStyle: 'bold' }, 1: { halign: 'right', fontStyle: 'bold' } },
        });

        y = doc.lastAutoTable.finalY + 15;
    };

    renderDataToTable('Grand Total (All Time)', grandTotal, true);

    const yrs = Object.keys(yearlyData).map(Number).sort((a, b) => b - a);
    yrs.forEach(year => {
        renderDataToTable(`Policy Year ${year}`, yearlyData[year], false);
    });

    doc.save(`Benefits_Report_${config.policyName || 'System'}.pdf`);
}

// --- UI ACTION LOGIC ---
function saveGoogleUrl() {
    const urlInput = document.getElementById('googleWebAppUrl');
    const url = urlInput ? urlInput.value.trim() : '';
    if (!url) {
        return Swal.fire('Error', 'Please enter your Google Web App URL first.', 'warning');
    }
    localStorage.setItem('googleWebAppUrl', url);
    Swal.fire({
        title: 'URL Saved!',
        text: 'Google Web App URL has been saved. Background Auto-Sync is now enabled.',
        icon: 'success',
        timer: 3000,
        showConfirmButton: false
    });
}

function removeGoogleUrl() {
    const savedUrl = localStorage.getItem('googleWebAppUrl');
    if (!savedUrl) {
        return Swal.fire('Info', 'There is no URL saved currently.', 'info');
    }
    Swal.fire({
        title: 'Remove URL?',
        text: 'Background auto sync will be disabled.',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        confirmButtonText: 'Yes, Remove it'
    }).then((result) => {
        if (result.isConfirmed) {
            localStorage.removeItem('googleWebAppUrl');
            const urlInput = document.getElementById('googleWebAppUrl');
            if (urlInput) urlInput.value = '';
            Swal.fire('Removed', 'URL removed successfully.', 'success');
        }
    });
}

function logoutSystem() {
    Swal.fire({
        title: 'Logout?',
        text: 'This will lock the current session and require a page reload.',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        confirmButtonText: 'Yes, Logout'
    }).then((result) => {
        if (result.isConfirmed) {
            typeof autoSyncToCloud === 'function' && autoSyncToCloud();
            window.location.reload();
        }
    });
}

// --- THEME TOGGLE LOGIC ---
const themeToggleBtn = document.getElementById('themeToggle');
const themeIcon = document.getElementById('themeIcon');

if (themeToggleBtn) {
    if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
        themeIcon.classList.replace('fa-moon', 'fa-sun');
    } else {
        document.documentElement.classList.remove('dark');
        themeIcon.classList.replace('fa-sun', 'fa-moon');
    }

    themeToggleBtn.addEventListener('click', () => {
        if (document.documentElement.classList.contains('dark')) {
            document.documentElement.classList.remove('dark');
            localStorage.theme = 'light';
            themeIcon.classList.replace('fa-sun', 'fa-moon');
        } else {
            document.documentElement.classList.add('dark');
            localStorage.theme = 'dark';
            themeIcon.classList.replace('fa-moon', 'fa-sun');
        }
    });
}

async function checkFirstTimeSync() {
    // Check if the app is fresh (no config saved yet and no web app url)
    const savedConfig = localStorage.getItem('policyConfig');
    const existingUrl = localStorage.getItem('googleWebAppUrl');

    if (!savedConfig && !existingUrl) {
        const { value: url } = await Swal.fire({
            title: 'Welcome to Health App!',
            text: 'It looks like this is your first time. If you have backed up data to Google Sheet before, paste the Web App URL here to restore it.',
            input: 'url',
            inputPlaceholder: 'https://script.google.com/macros/s/.../exec',
            showCancelButton: true,
            confirmButtonText: 'Sync Data',
            cancelButtonText: 'Skip for now',
            confirmButtonColor: '#4f46e5',
            inputValidator: (value) => {
                if (value && !value.startsWith('http')) {
                    return 'Please enter a valid URL';
                }
            }
        });

        if (url) {
            localStorage.setItem('googleWebAppUrl', url.trim());
            // Automatically populate the input box if user navigates to settings
            const urlInput = document.getElementById('googleWebAppUrl');
            if (urlInput) urlInput.value = url.trim();

            // Call the syncFromCloud to download data
            await syncFromCloud();
            return; // syncFromCloud reloads the page on success
        }
    }

    // If skipped or not first time, just initialize normally
    initApp();
}

// --- PREMIUM LOCK SCREEN UI LOGIC ---
let enteredPin = "";

function updatePinDots() {
    const dots = document.getElementById('pinDots');
    if (!dots) return;
    for (let i = 0; i < 4; i++) {
        if (i < enteredPin.length) {
            dots.children[i].className = "w-4 h-4 rounded-full bg-white transition-all duration-200 scale-125 shadow-[0_0_10px_rgba(255,255,255,0.8)]";
        } else {
            dots.children[i].className = "w-4 h-4 rounded-full bg-white/20 border border-white/30 transition-all duration-200";
        }
    }
}

function pressPin(digit) {
    if (enteredPin.length < 4) {
        enteredPin += digit;
        document.getElementById('loginErrorMsg').classList.remove('opacity-100');
        updatePinDots();

        if (enteredPin.length === 4) {
            verifyPin();
        }
    }
}

function pressPinBackspace() {
    if (enteredPin.length > 0) {
        enteredPin = enteredPin.slice(0, -1);
        document.getElementById('loginErrorMsg').classList.remove('opacity-100');
        updatePinDots();
    }
}

function verifyPin() {
    if (enteredPin === config.appPin) {
        // Success
        const loginScreen = document.getElementById('loginScreen');
        loginScreen.style.opacity = '0';
        setTimeout(() => {
            loginScreen.classList.add('hidden');
            document.getElementById('appContainer').classList.remove('hidden');
            // Give time for display:block to apply before fading in
            setTimeout(() => {
                document.getElementById('appContainer').classList.remove('opacity-0');
            }, 50);
            checkFirstTimeSync();
        }, 300);
    } else {
        // Error Shake
        const card = document.getElementById('loginCard');
        card.classList.add('anim-shake');
        document.getElementById('loginErrorMsg').classList.add('opacity-100');

        setTimeout(() => {
            card.classList.remove('anim-shake');
            enteredPin = "";
            updatePinDots();
        }, 500);
    }
}

async function authenticateUser() {
    if (config.appPin && config.appPin.length === 4) {
        const loginScreen = document.getElementById('loginScreen');
        const welcomeText = document.getElementById('loginWelcomeText');

        if (welcomeText) {
            const firstName = config.policyName ? config.policyName.split(' ')[0] : 'Policyholder';
            welcomeText.innerHTML = `Welcome Back,<br/><span class="text-brand-200 text-xl">${firstName}</span>`;
        }

        loginScreen.classList.remove('hidden');
        loginScreen.classList.add('flex');

        // Let CSS transition kick in
        setTimeout(() => {
            loginScreen.classList.remove('opacity-0');
        }, 50);

        enteredPin = "";
        updatePinDots();
    } else {
        document.getElementById('appContainer').classList.remove('hidden');
        setTimeout(() => {
            document.getElementById('appContainer').classList.remove('opacity-0');
        }, 50);
        checkFirstTimeSync();
    }
}

// Global hook for physical keyboard pin entry
document.addEventListener('keydown', (e) => {
    const loginScreen = document.getElementById('loginScreen');
    if (loginScreen && !loginScreen.classList.contains('hidden') && loginScreen.style.opacity !== '0') {
        if (/^[0-9]$/.test(e.key)) {
            pressPin(e.key);
        } else if (e.key === 'Backspace') {
            pressPinBackspace();
        }
    }
});

// --- INACTIVITY AUTO LOGOUT (10 Mins) ---
let inactivityTimeout;
function resetInactivityTimeout() {
    clearTimeout(inactivityTimeout);
    // Only set the timeout if a PIN is actually configured, otherwise locking doesn't make sense.
    if (config && config.appPin && config.appPin.length === 4) {
        inactivityTimeout = setTimeout(() => {
            // After 10 mins (600,000 ms) of no interaction, reload to lock screen
            window.location.reload();
        }, 10 * 60 * 1000); // 10 minutes
    }
}

// Listen to common actions to reset timeout
['mousemove', 'mousedown', 'keypress', 'touchstart', 'scroll'].forEach(evt => {
    document.addEventListener(evt, resetInactivityTimeout, { passive: true });
});

window.addEventListener('DOMContentLoaded', () => {
    authenticateUser();
    resetInactivityTimeout();
});