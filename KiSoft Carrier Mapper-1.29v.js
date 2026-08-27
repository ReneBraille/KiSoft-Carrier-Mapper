// ==UserScript==
// @name         KiSoft Carrier Mapper
// @namespace    http://tampermonkey.net/
// @version      1.29v
// @description  Dodatkowa informacja o subwave w KiSoft Navigator
// @author       vasyl.hospodyn@cevalogistics.com
// @match        https://gdcgrafana-eu.logistics.corp/d/dOHkIABY83AGEIHMDTLOPSPRODSTD/ageing-heatmap-detail-prod?orgId=1*
// @match        https://10.218.15.10:4444/af/*
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==





// =========================================================
    // GLOBALNE USTAWIENIA
    // Ten blok przechowuje wszystkie stałe konfiguracyjne używane
    // przez userscript: adres bieżącej strony, interwały czasowe,
    // progi cutoff dla carrierów, grupy carrierów oraz flagi stanu.
    // Dane z tej sekcji są wykorzystywane później w logice syncu,
    // filtrowania, auto-refreshu i renderowania informacji w tabeli.
    // =========================================================
(function () {
    'use strict';
// Aktualny adres strony, na której uruchomiony jest skrypt.
    const CURRENT_URL = window.location.href;
    // Czas automatycznej synchronizacji danych:
    // 1 200 000 ms = 20 minut.
    const AUTO_SYNC_MS = 1200000;
    // Szybkość animacji migania alertów.
    const BLINK_SPEED_SECONDS = 2.2;
     // Opóźnienie odświeżania w sekundach.
    const REFRESH_DELAY_SECONDS = 15;
// Godziny cutoff dla poszczególnych carrierów.
    // Są wykorzystywane później do określania statusu SLA,
    // D2 oraz alertów krytycznych.
    const CARRIER_CUTOFFS = {
        "DHLPAK-EX": "08:00",
        "HERMESDE-EX": "10:00",
        "ZAS-EX": "11:00",
        "PPL-EX": "13:30",
        "UB-INPOST": "14:30",
        "UB-OMNIVA": "15:30",
        "B2B-VIP": "20:00",
        "SCD": "23:00",
    };
// Grupa carrierów traktowanych jako SCD podczas filtrowania.
    const SCD_GROUP = [
        "HERMESINT-EX", "ACS-CY", "ACS-GR", "BPOST-EX", "COLISSIMO-EX",
        "DHLPAK-RET-EX", "ECONT", "GLSHU-MAGYAR-EX", "MAGYAR-POSTA", "POSTA-SI",
        "POSTE-IT", "POSTNL-EX", "SK-POSTA-EX", "SWISSPOST-EX", "UB-CORREOS", "UB-CTT",
        "UB-DHLSE", "UB-FASTWAY", "UB-GLSDK", "UB-POSTI", "UB-POSTNORD", "UB-SEUR-ES",
        "UPS-EX", "ZAS-EX-SK", "FAN-V2-EX","CROATIANPOST-EX"
    ];
// Warianty OMNIVA traktowane jako jedna grupa.
    const UB_OMNIVA_GROUP = ["UB-OMNIVA-LT", "UB-OMNIVA-LV", "UB-OMNIVA-EE"];
// Sprawdzenie, czy aktualnie znajdujemy się na stronie Grafany.
    const isGrafanaDomain = CURRENT_URL.includes('gdcgrafana-eu.logistics.corp');
    // Collector Grafany działa tylko na widoku zawierającym #TEST.
    const isTargetView = CURRENT_URL.includes('#TEST');
/* ============================================================
       GRAFANA DATA COLLECTOR
       ============================================================ */

    // Jeżeli jesteśmy na właściwym widoku Grafany,
    // uruchamiamy moduł zbierający dane.
    if (isGrafanaDomain && isTargetView) {
        console.log('[Grafana] Collector Active');
// --------------------------------------------------------
        // STATUS UI
        // --------------------------------------------------------
        // Mały panel w prawym dolnym rogu informujący o stanie
        // pobierania danych z tabeli Grafany.
        const StatusUI = {
            element: null,
            // Tworzenie panelu statusu.
            create() {
                const div = document.createElement('div');
                div.style.cssText = `position:fixed;bottom:10px;right:10px;background:#1e1e1e;color:#eee;padding:12px;border-radius:6px;border:1px solid #555;box-shadow:0 4px 12px rgba(0,0,0,0.5);font-family:monospace;font-size:11px;z-index:99999;min-width:220px;`;
                div.innerHTML = `
                    <div style="font-weight:bold;color:#64b5f6;margin-bottom:6px;">Grafana Sync</div>
                    <div>Status: <span id="gc-status" style="color:#ffb74d">Scanning...</span></div>
                    <div>Rekordów: <span id="gc-count" style="font-weight:bold">0</span></div>
                `;
                document.body.appendChild(div);
                // Zapamiętanie referencji do panelu.
                this.element = div;
            },
             // Aktualizacja informacji widocznych w panelu.
            update(status, count, isSuccess) {
                // Jeśli panel jeszcze nie istnieje — tworzymy go.
                if (!this.element) this.create();
                const s = document.getElementById('gc-status');
                const c = document.getElementById('gc-count');
                 // Aktualizacja tekstu statusu.
                s.textContent = status;
                // Zielony = sukces, pomarańczowy = oczekiwanie/skanowanie.
                s.style.color = isSuccess ? '#81c784' : '#ffb74d';
                 // Aktualizacja liczby znalezionych rekordów.
                c.textContent = count;
                 // Zmiana koloru obramowania panelu.
                this.element.style.borderColor = isSuccess ? '#2e7d32' : '#555';
            }
        };
// --------------------------------------------------------
        // DATA COLLECTOR
        // --------------------------------------------------------
        // Odczytuje dane z tabeli znajdującej się na stronie Grafany
        // i zapisuje je w pamięci Tampermonkey.
        const DataCollector = {
            collectData() {
                // Najpierw próbujemy znaleźć standardowe wiersze tabeli.
                let rows = Array.from(document.querySelectorAll('table tr'));
                // Jeśli tabela nie została znaleziona,
                // próbujemy pobrać wiersze z gridu.
                if (rows.length < 2) rows = Array.from(document.querySelectorAll('div[role="row"]'));
 // Tablica rekordów, które zostaną przekazane do KiSoft.
                let collectedRows = [];
                 // Licznik znalezionych rekordów MULT.
                let count = 0;
 // Przetwarzanie każdego wiersza.
                rows.forEach(row => {
                    // Pobranie komórek TD
                    let cells = row.querySelectorAll('td');
                    // Pobranie komórek TD
                    if (cells.length === 0) cells = Array.from(row.children);
                     // Zamiana komórek na tablicę tekstów.
                    const rowData = Array.from(cells).map(c => c.textContent.trim());
// Interesują nas tylko rekordy MULT.
                    if (rowData.length > 7 && rowData[0].startsWith('MULT')) {
                        // Tworzenie uproszczonego obiektu danych.
                        collectedRows.push({
                            // Nazwa subwave.
                            workGroup: rowData[0],
                            // Typ zamówienia, np. STD/VIP.
                            orderType: rowData[1] || '',
                            // Carrier.
                            carrierId: rowData[2] || '',
                            // Ship By Date.
                            shipByDate: rowData[3] || '',
                            // Liczba zamówień.
                            valOrders: parseInt(rowData[5] || '0', 10),
                            // Liczba linii.
                            valLines: parseInt(rowData[6] || '0', 10),
                            // Liczba taskowanych elementów.
                            valTasked: parseInt(rowData[7] || '0', 10),
                            // Shipment Group / OSR.
                            shipmentGroup: rowData[9] || ''
                        });
                        count++;
                    }
                });
 // Jeśli znaleziono dane,
                // zapisujemy je w pamięci Tampermonkey.
                if (count > 0) {
                    GM_setValue('unified_grafana_data', JSON.stringify(collectedRows));
                    StatusUI.update('SEND TO KISOFT', count, true);
                } else {
                    // Brak danych MULT.
                    StatusUI.update('Search Data...', 0, false);
                }
            }
        };
// Utworzenie panelu statusu po 1,5 sekundy.
        setTimeout(() => StatusUI.create(), 1500);
 // Co 3 sekundy ponownie skanujemy dane w Grafanie.
        setInterval(DataCollector.collectData, 3000);
        return;
        // Jeśli jesteśmy na Grafanie, ale nie na widoku #TEST,
    // skrypt nie uruchamia collectora.
    } else if (isGrafanaDomain) {
        console.log('[Grafana] Skrypt wstrzymany - niewłaściwy widok (brak #TEST).');
        return;
    }
/* ============================================================
       KISOFT MAPPER
       ============================================================ */
    console.log('[KiSoft] Mapper v3.25 Loaded');
// Główna struktura danych.
    // Przechowuje informacje o każdym MULT/subwave.
    let mapping = {};
    let vipCarriers = {};
    let osrAssignments = {};
    let subwaveStatus = GM_getValue(
    'kisoft_subwave_status',
    {}
);
    let autoSyncInterval = null;
    let autoSyncCountdownInterval = null;
    let focusModeEnabled = false;
    let upoTrendPanelOpen = false;
    let carrierFilterText = '';
// ============================================================
// GRAFANA DATA CHANGE DETECTION
// Przechowuje ostatnią wersję danych z Grafany.
// Dzięki temu nie przebudowujemy całego mapping i DOM,
// jeśli dane są identyczne jak przy poprzednim sync.
// ============================================================
let lastGrafanaDataHash = '';

   const OSR_ASSIGNMENTS_KEY = 'kisoft_osr_assignments_v1';
const UPO_HISTORY_KEY = 'kisoft_upo_history_by_osr_v1';

// UPO zapisujemy co 15 minut.
const UPO_HISTORY_INTERVAL_MS = 15 * 60 * 1000;

// Trzymamy 12 godzin historii.
const UPO_HISTORY_RETENTION_MS = 12 * 60 * 60 * 1000;

let lastUpoHistorySaveTs = 0;
 /* ============================================================
       OSR ASSIGNMENTS
       ============================================================ */

    // Zapisuje przypisanie MULT → OSR w LocalStorage.
    function saveOsrAssignments() {
        localStorage.setItem(OSR_ASSIGNMENTS_KEY, JSON.stringify(osrAssignments));
    }

    function loadOsrAssignments() {
        try {
            osrAssignments = JSON.parse(localStorage.getItem(OSR_ASSIGNMENTS_KEY) || '{}');
        } catch (e) {
            osrAssignments = {};
        }
    }
// ------------------------------------------------------------
    // Automatyczne wykrywanie OSR na podstawie widocznych wierszy.
    // ------------------------------------------------------------
    function learnOsrAssignmentsFromVisibleRows() {
        let subwaveColIndex = -1;

        document.querySelectorAll('td, th').forEach(el => {
            let textSpan = el.querySelector('.overflow-ellipsis');
            let text = textSpan ? textSpan.textContent.trim().toUpperCase() : el.textContent.trim().toUpperCase();

            if (text === 'SUBWAVE') {
                const tr = el.closest('tr');
                if (tr) subwaveColIndex = Array.from(tr.children).indexOf(el);
            }
        });

        if (subwaveColIndex === -1) return;

        const allRows = Array.from(document.querySelectorAll('tr')).filter(tr => tr.querySelectorAll('td').length > 0);
        let currentGroupedOsr = null;
        let changed = false;

        allRows.forEach(row => {
            const rowText = row.textContent.toUpperCase();
            const groupCell = row.querySelector('td.dx-group-cell');

            if (groupCell) {
                const groupText = groupCell.textContent.toUpperCase();
                if (groupText.includes("OSR1_A1") || groupText.includes("OSR1 A1") || groupText.includes("OSR1A1")) {
                    currentGroupedOsr = "OSR1_A1";
                } else if (groupText.includes("OSR1_A2") || groupText.includes("OSR1 A2") || groupText.includes("OSR1A2")) {
                    currentGroupedOsr = "OSR1_A2";
                }
                return;
            }

            const cells = Array.from(row.children);
            if (cells.length <= subwaveColIndex) return;

            const rawSubwaveText = cells[subwaveColIndex] ? cells[subwaveColIndex].textContent.trim() : '';
            const match = rawSubwaveText.match(/^MULT\d+/);
            if (!match) return;

            const mult = match[0].replace(/\s+/g, '');
            let osrAisle = null;

            if (rowText.includes("OSR1_A1") || rowText.includes("OSR1 A1") || rowText.includes("OSR1A1")) osrAisle = "OSR1_A1";
            else if (rowText.includes("OSR1_A2") || rowText.includes("OSR1 A2") || rowText.includes("OSR1A2")) osrAisle = "OSR1_A2";
            else if (currentGroupedOsr) osrAisle = currentGroupedOsr;

            if (mult && osrAisle && osrAssignments[mult] !== osrAisle) {
                osrAssignments[mult] = osrAisle;
                changed = true;
            }
        });

        if (changed) saveOsrAssignments();
    }
/* ============================================================
       UPO CALCULATIONS
       ============================================================ */
    // Oblicza aktualne dane UPO osobno dla OSR1_A1 i OSR1_A2.
    function getCurrentOsrAggregates() {
        const totals = {
            OSR1_A1: { sumG: 0, sumE: 0, items: 0, mults: 0 },
            OSR1_A2: { sumG: 0, sumE: 0, items: 0, mults: 0 }
        };

        Object.keys(mapping).forEach(subwave => {
            const rec = mapping[subwave];
            const osr = osrAssignments[subwave];

            if (!rec || !osr || !totals[osr]) return;

            totals[osr].sumG += rec.sumG || 0;
            totals[osr].sumE += rec.sumE || 0;
            totals[osr].items += (rec.std || 0) + (rec.vip || 0);
            totals[osr].mults += 1;
        });

        return {
            OSR1_A1: {
                upo: totals.OSR1_A1.sumE ? Number((totals.OSR1_A1.sumG / totals.OSR1_A1.sumE).toFixed(2)) : null,
                sumG: totals.OSR1_A1.sumG,
                sumE: totals.OSR1_A1.sumE
            },
            OSR1_A2: {
                upo: totals.OSR1_A2.sumE ? Number((totals.OSR1_A2.sumG / totals.OSR1_A2.sumE).toFixed(2)) : null,
                sumG: totals.OSR1_A2.sumG,
                sumE: totals.OSR1_A2.sumE
            }
        };
    }
// ------------------------------------------------------------
// POBIERANIE HISTORII UPO
// ------------------------------------------------------------
function getUpoHistory() {
    try {
        return JSON.parse(
            GM_getValue(UPO_HISTORY_KEY, '{}')
        ) || {};
    } catch (e) {
        return {};
    }
}

// ------------------------------------------------------------
// ZAPIS HISTORII UPO
// ------------------------------------------------------------
function saveUpoHistory(store) {
    GM_setValue(
        UPO_HISTORY_KEY,
        JSON.stringify(store)
    );
}

// ------------------------------------------------------------
// RESET HISTORII UPO
// ------------------------------------------------------------
function resetUpoHistory() {

    saveUpoHistory({
        OSR1_A1: [],
        OSR1_A2: []
    });

    lastUpoHistorySaveTs = 0;

    console.log('[UPO] History reset');

    if (upoTrendPanelOpen) {
        renderUpoTrendPanel();
    }
}

// ------------------------------------------------------------
// ZAOKRĄGLENIE CZASU DO PEŁNEJ GODZINY
//
// Przykład:
// 17:23 -> godzina historyczna = 17:00
// 17:58 -> godzina historyczna = 17:00
// 18:00 -> godzina historyczna = 18:00
// ------------------------------------------------------------
function getHourStartTs(ts) {
    const date = new Date(ts);

    date.setMinutes(0, 0, 0);

    return date.getTime();
}

// ------------------------------------------------------------
// FORMAT GODZINY
// ------------------------------------------------------------
function formatHistoryHour(ts) {
    if (typeof ts !== 'number') return '--:--';

    const date = new Date(ts);

    return [
        String(date.getHours()).padStart(2, '0'),
        String(date.getMinutes()).padStart(2, '0')
    ].join(':');
}

// ------------------------------------------------------------
// DODAWANIE AKTUALNEGO UPO DO HISTORII
//
// UPO jest zapisywane maksymalnie raz na 20 minut.
//
// Ważne:
// Nie przesuwamy pomiarów na pełną godzinę.
// Zachowujemy prawdziwy timestamp pomiaru.
//
// Dzięki temu np.:
// 17:02
// 17:22
// 17:42
//
// wszystkie należą do godziny 17:00–17:59.
// ------------------------------------------------------------
function recordUpoHistory() {

    const now = Date.now();

    // Zapis maksymalnie raz na 15 minut.
    if (
        lastUpoHistorySaveTs > 0 &&
        now - lastUpoHistorySaveTs < UPO_HISTORY_INTERVAL_MS
    ) {
        return;
    }

    learnOsrAssignmentsFromVisibleRows();

    const current = getCurrentOsrAggregates();
    const store = getUpoHistory();

    ['OSR1_A1', 'OSR1_A2'].forEach(osr => {

        if (!store[osr]) {
            store[osr] = [];
        }

        // Nie zapisujemy pustego UPO.
        if (
            current[osr] &&
            current[osr].upo != null &&
            !isNaN(current[osr].upo)
        ) {
            store[osr].push({
                ts: now,
                upo: Number(current[osr].upo)
            });
        }

        // Usuwamy stare dane.
        store[osr] = store[osr].filter(item =>
            item &&
            typeof item.ts === 'number' &&
            now - item.ts <= UPO_HISTORY_RETENTION_MS
        );
    });

    lastUpoHistorySaveTs = now;

    saveUpoHistory(store);

    console.log(
        '[UPO] History saved:',
        new Date(now).toLocaleTimeString(),
        current
    );
}

// ------------------------------------------------------------
// ŚREDNIA UPO DLA KONKRETNEJ PEŁNEJ GODZINY(update beda jeszcze dodawane h)
//
// hourOffset:
// 0  = aktualna godzina
// 1  = poprzednia godzina
// 2  = godzina 2h wcześniej
// 4  = godzina 4h wcześniej
//
// Przykład przy 18:00:
//
// hourOffset = 1
// => 17:00–17:59
//
// hourOffset = 2
// => 16:00–16:59
//
// hourOffset = 4
// => 14:00–14:59
// ------------------------------------------------------------
function getUpoHourlyAverage(history, hourOffset) {

    if (!Array.isArray(history) || history.length === 0) {
        return null;
    }

    const now = new Date();

    // Początek aktualnej pełnej godziny.
    const currentHourStart = new Date(now);
    currentHourStart.setMinutes(0, 0, 0);

    // Początek szukanej godziny.
    const targetStart = new Date(currentHourStart);
    targetStart.setHours(
        targetStart.getHours() - hourOffset
    );

    // Koniec szukanej godziny.
    const targetEnd = new Date(targetStart);
    targetEnd.setHours(
        targetEnd.getHours() + 1
    );

    const fromTs = targetStart.getTime();
    const toTs = targetEnd.getTime();

    const values = history
        .filter(item =>
            item &&
            typeof item.ts === 'number' &&
            item.ts >= fromTs &&
            item.ts < toTs &&
            item.upo != null &&
            !isNaN(item.upo)
        )
        .map(item => Number(item.upo));

    // Brak pomiarów w danej godzinie.
    if (values.length === 0) {
        return null;
    }

    const sum = values.reduce(
        (acc, value) => acc + value,
        0
    );

    const average = sum / values.length;

    return {
        value: Number(average.toFixed(2)),
        hourTs: fromTs,
        samples: values.length
    };
}

// ------------------------------------------------------------
// FORMATOWANIE DELTY
// ------------------------------------------------------------
function formatDelta(curr, prev) {

    if (
        curr == null ||
        prev == null ||
        isNaN(curr) ||
        isNaN(prev)
    ) {
        return {
            text: 'no history',
            cls: 'kisoft-trend-muted'
        };
    }

    const delta = Number(
        (curr - prev).toFixed(2)
    );

    if (Math.abs(delta) < 0.01) {
        return {
            text: `→ ${delta.toFixed(2)}`,
            cls: 'kisoft-trend-delta-flat'
        };
    }

    if (delta > 0) {
        return {
            text: `↑ +${delta.toFixed(2)}`,
            cls: 'kisoft-trend-delta-up'
        };
    }

    return {
        text: `↓ ${delta.toFixed(2)}`,
        cls: 'kisoft-trend-delta-down'
    };
}
// ------------------------------------------------------------
// DEBUG / PODGLĄD SUROWEJ HISTORII UPO
// ------------------------------------------------------------
function showUpoHistoryDebug() {

    const historyStore = getUpoHistory();

    // Aktualna pełna godzina.
    const now = new Date();
    const currentHourStart = new Date(now);
    currentHourStart.setMinutes(0, 0, 0);

    const currentHourTs = currentHourStart.getTime();

    let html = `
        <div
            class="kisoft-upo-debug-overlay"
            id="kisoft-upo-debug-overlay"
        >

            <div class="kisoft-upo-debug-modal">

                <div class="kisoft-upo-debug-header">
                    <b>🔍 UPO History — grouped by hour</b>

                    <button
                        id="kisoft-close-upo-debug"
                        type="button"
                    >
                        ✕
                    </button>
                </div>

                <div class="kisoft-upo-debug-body">
    `;

    ['OSR1_A1', 'OSR1_A2'].forEach(osr => {

        const history = Array.isArray(historyStore[osr])
            ? historyStore[osr]
            : [];

        html += `
            <div class="kisoft-upo-debug-osr">
                <h4>${osr}</h4>
        `;

        if (history.length === 0) {

            html += `
                <div style="color:blue;">
                    no history
                </div>
            `;

            html += `</div>`;
            return;
        }

        // ----------------------------------------------------
        // GRUPOWANIE POMIARÓW WG PEŁNEJ GODZINY
        // ----------------------------------------------------
        const groups = {};

        history
            .slice()
            .sort((a, b) => a.ts - b.ts)
            .forEach(item => {

                if (
                    !item ||
                    typeof item.ts !== 'number' ||
                    item.upo == null ||
                    isNaN(item.upo)
                ) {
                    return;
                }

                const hourTs = getHourStartTs(item.ts);

                if (!groups[hourTs]) {
                    groups[hourTs] = [];
                }

                groups[hourTs].push(item);
            });

        // Najnowsza godzina na górze.
        const sortedHours = Object.keys(groups)
            .map(Number)
            .sort((a, b) => b - a);

        sortedHours.forEach(hourTs => {

            const items = groups[hourTs];

            const values = items
                .map(item => Number(item.upo))
                .filter(value => !isNaN(value));

            if (!values.length) {
                return;
            }

            // ------------------------------------------------
            // ŚREDNIA DLA TEJ KONKRETNEJ GODZINY
            // ------------------------------------------------
            const avg = (
                values.reduce(
                    (sum, value) => sum + value,
                    0
                ) / values.length
            ).toFixed(2);

            // ------------------------------------------------
            // OKREŚLENIE "1h avg ago", "2h avg ago" itd.
            // ------------------------------------------------
            const hoursAgo = Math.round(
                (currentHourTs - hourTs) /
                (60 * 60 * 1000)
            );

            let periodLabel = '';

            if (hoursAgo >= 1 && hoursAgo <= 4) {

                periodLabel = `
                    <span
                        style="
                            margin-left:8px;
                            color:#1565c0;
                            font-weight:bold;
                        "
                    >
                        ← ${hoursAgo}h avg ago
                    </span>
                `;

            } else if (hoursAgo === 0) {

                periodLabel = `
                    <span
                        style="
                            margin-left:9px;
                            color:Navy;
                             font-weight:bold;
                        "
                    >
                        ← current hour
                    </span>
                `;
            }

            // Koniec godziny.
            const hourEnd = new Date(hourTs);
            hourEnd.setHours(
                hourEnd.getHours() + 1
            );

            hourEnd.setMinutes(
                hourEnd.getMinutes() - 1
            );

            const hourLabel =
                `${formatHistoryHour(hourTs)}–${formatHistoryHour(hourEnd.getTime())}`;

            // ------------------------------------------------
            // GRUPA GODZINOWA
            // ------------------------------------------------
            html += `
                <div class="kisoft-upo-debug-hour">

                    <div class="kisoft-upo-debug-hour-title">

                        <div>
                            <b>${hourLabel}</b>
                            ${periodLabel}
                        </div>

                        <div>
                            AVG:
                            <strong>${avg}</strong>
                        </div>

                    </div>
            `;

            // ------------------------------------------------
            // SUROWE POMIARY W TEJ GODZINIE
            // ------------------------------------------------
            items.forEach(item => {

                html += `
                    <div class="kisoft-upo-debug-item">

                        <span>
                            ${formatHistoryHour(item.ts)}
                        </span>

                        <strong>
                            ${Number(item.upo).toFixed(2)}
                        </strong>

                        <span style="color:#888;">
                            ${new Date(item.ts).toLocaleString()}
                        </span>

                    </div>
                `;
            });

            // ------------------------------------------------
            // PODSUMOWANIE GRUPY
            // ------------------------------------------------
            html += `
                    <div
                        style="
                            padding:7px 10px;
                            background:SkyBlue;
                            border-top:1px solid DarkBlue;
                            font-size:12px;
                        "
                    >
                        <b>
                            AVG ${hourLabel} = ${avg}
                        </b>

                        <span style="color:#777;">
                            (${values.length} samples)
                        </span>
                    </div>

                </div>
            `;
        });

        html += `
            </div>
        `;
    });

    html += `
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML(
        'beforeend',
        html
    );

    // --------------------------------------------------------
    // ZAMKNIĘCIE OKNA
    // --------------------------------------------------------
    const overlay = document.getElementById(
        'kisoft-upo-debug-overlay'
    );

    const closeBtn = document.getElementById(
        'kisoft-close-upo-debug'
    );

    if (closeBtn) {

        closeBtn.addEventListener(
            'click',
            () => overlay.remove()
        );
    }

    if (overlay) {

        overlay.addEventListener(
            'click',
            event => {

                if (event.target === overlay) {
                    overlay.remove();
                }

            }
        );
    }
}
// =========================================================
    // PANEL UPO TREND
    // Ten blok buduje i aktualizuje pływający panel pokazujący:
    // - bieżące UPO dla OSR1_A1 i OSR1_A2,
    // - średnie UPO z ostatniej 1h, 2h i 4h,
    // - różnicę między bieżącym wynikiem a średnią historyczną.
    // Panel korzysta z danych zapisanych wcześniej w mapping i UPO history.
    // =========================================================
    function ensureUpoTrendPanel() {
        let panel = document.getElementById('kisoft-upo-trend-panel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'kisoft-upo-trend-panel';
            document.body.appendChild(panel);
        }
        return panel;
    }

    function positionTrendPanelUnderButton(btn) {
        const panel = ensureUpoTrendPanel();
        const rect = btn.getBoundingClientRect();
        const top = rect.bottom + window.scrollY + 8;
        const left = rect.left + window.scrollX;

        panel.style.position = 'absolute';
        panel.style.top = `${top}px`;
        panel.style.left = `${left}px`;
    }

  function renderUpoTrendPanel() {

    learnOsrAssignmentsFromVisibleRows();

    const panel = ensureUpoTrendPanel();
    const historyStore = getUpoHistory();
    const current = getCurrentOsrAggregates();

    let html = `
        <div class="kisoft-trend-header">
    <h3>📈 UPO Trend — OSR summary</h3>
</div>

<div class="kisoft-trend-actions">
    <button
        id="kisoft-show-upo-history"
        class="kisoft-reset-history-btn"
        type="button"
        title="Show raw UPO history"
    >
        🔍 Show history
    </button>

    <button
        id="kisoft-reset-upo-history"
        class="kisoft-reset-history-btn"
        type="button"
        title="Reset UPO history"
    >
        🗑 Reset history
    </button>
</div>
    `;

    ['OSR1_A1', 'OSR1_A2'].forEach(osr => {

        const nowRec = current[osr];
        const history = historyStore[osr] || [];

        // ----------------------------------------------------
        // NOW
        // ----------------------------------------------------
        const nowUpo = nowRec.upo;

        // ----------------------------------------------------
        // HISTORIA
        //
        // 1h = poprzednia pełna godzina
        // 2h = godzina 2 godziny wcześniej
        // 4h = godzina 4 godziny wcześniej
        // ----------------------------------------------------
        const h1 = getUpoHourlyAverage(history, 1);
        const h2 = getUpoHourlyAverage(history, 2);
        const h3 = getUpoHourlyAverage(history, 3);
        const h4 = getUpoHourlyAverage(history, 4);

        // ----------------------------------------------------
        // DELTA
        // ----------------------------------------------------
        const d1 = formatDelta(
            nowUpo,
            h1 ? h1.value : null
        );

        const d2 = formatDelta(
            nowUpo,
            h2 ? h2.value : null
        );
        const d3 = formatDelta(
    nowUpo,
    h3 ? h3.value : null
);

        const d4 = formatDelta(
            nowUpo,
            h4 ? h4.value : null
        );

        // ----------------------------------------------------
        // TEKST GODZINY HISTORII
        // ----------------------------------------------------
        function formatHistoryHourRange(hourTs) {

    if (typeof hourTs !== 'number') {
        return '--:--';
    }

    const start = formatHistoryHour(hourTs);

    const endDate = new Date(hourTs);
    endDate.setMinutes(59);

    const end = formatHistoryHour(endDate.getTime());

    return `${start}-${end}`;
}
        const h1Time = h1
    ? formatHistoryHourRange(h1.hourTs)
    : '--:--';

const h2Time = h2
    ? formatHistoryHourRange(h2.hourTs)
    : '--:--';

const h3Time = h3
    ? formatHistoryHourRange(h3.hourTs)
    : '--:--';

const h4Time = h4
    ? formatHistoryHourRange(h4.hourTs)
    : '--:--';

        // ----------------------------------------------------
        // RENDER
        // ----------------------------------------------------
        html += `
            <div
                class="kisoft-trend-row"
                style="align-items:flex-start;"
            >

                <div class="kisoft-trend-left">
                    ${osr}
                </div>

                <div class="kisoft-trend-mid">

                    <div>
                        <b>🔷 Now UPO:</b>
                        ${nowUpo ?? '-'}
                    </div>

                    <div>
                       🔹avg 1h ago
                        <span style="color:#777;">
                            (${h1Time})
                        </span>:
                        <b>
                            ${h1 ? h1.value : 'no history'}
                        </b>

                        ${
                            h1
                                ? `| <span class="${d1.cls}">${d1.text}</span>`
                                : ''
                        }
                    </div>

                    <div>
                       🔹avg 2h ago
                        <span style="color:#777;">
                            (${h2Time})
                        </span>:
                        <b>
                            ${h2 ? h2.value : 'no history'}
                        </b>

                        ${
                            h2
                                ? `| <span class="${d2.cls}">${d2.text}</span>`
                                : ''
                        }
                    </div>
                    <div>
   🔹avg 3h ago
    <span style="color:#777;">
        (${h3Time})
    </span>:
    <b>
        ${h3 ? h3.value : 'no history'}
    </b>

    ${
        h3
            ? `| <span class="${d3.cls}">${d3.text}</span>`
            : ''
    }
</div>

                    <div>
                       🔹avg 4h ago
                        <span style="color:#777;">
                            (${h4Time})
                        </span>:
                        <b>
                            ${h4 ? h4.value : 'no history'}
                        </b>

                        ${
                            h4
                                ? `| <span class="${d4.cls}">${d4.text}</span>`
                                : ''
                        }
                    </div>

                </div>
            </div>
        `;
    });

    panel.innerHTML = html;

    // ------------------------------------------------------------
    // OBSŁUGA RESET HISTORY
    // ------------------------------------------------------------
    const resetBtn = document.getElementById(
        'kisoft-reset-upo-history'
    );
const showHistoryBtn = document.getElementById(
    'kisoft-show-upo-history'
);

if (showHistoryBtn) {
    showHistoryBtn.addEventListener(
        'click',
        showUpoHistoryDebug
    );
}
    if (resetBtn) {

        resetBtn.addEventListener('click', () => {

            const confirmed = confirm(
                'Czy na pewno chcesz wyczyścić całą historię UPO?\n\n' +
                'OSR1_A1 i OSR1_A2 rozpoczną zbieranie historii od nowa.'
            );

            if (!confirmed) {
                return;
            }

            resetUpoHistory();

            renderUpoTrendPanel();
        });
    }
}


// ------------------------------------------------------------
// OBSŁUGA PRZYCISKU RESET HISTORY
// ------------------------------------------------------------
const resetBtn = document.getElementById('kisoft-reset-upo-history');

if (resetBtn) {

    resetBtn.addEventListener('click', () => {

        // Dodatkowe zabezpieczenie przed przypadkowym kliknięciem.
        const confirmed = confirm(
            'Czy na pewno chcesz wyczyścić całą historię UPO?\n\n' +
            'OSR1_A1 i OSR1_A2 rozpoczną zbieranie historii od nowa.'
        );

        if (!confirmed) {
            return;
        }

        // Reset historii.
        resetUpoHistory();

        // Ponowne wyrenderowanie panelu.
        renderUpoTrendPanel();
    });
}
    
// =========================================================
    // FILTRY
    // Ten blok odpowiada za filtrowanie widocznych wierszy w tabeli KiSoft.
    // Obsługuje dwa mechanizmy:
    // - Focus mode, który pokazuje tylko wybrane statusy operacyjne,
    // - Carrier filter, który pokazuje tylko subwave powiązane z danym carrierem.
    // Filtrowanie działa na już istniejących danych mappingu i nie tworzy
    // nowych rekordów - zmienia jedynie widoczność wierszy w tabeli.
    // =========================================================
    function applyCombinedFilters() {

    const visibleRows = Array.from(document.querySelectorAll('tr')).filter(tr => {
        return tr.querySelectorAll('td').length > 0;
    });

    visibleRows.forEach(row => {

        const cells = Array.from(row.querySelectorAll('td'));

        const subwaveCell = cells.find(td =>
            /^MULT\d+/i.test(td.textContent.trim())
        );

        const statusCell = cells.find(td => {
            const t = td.textContent.trim();
            return [
                "Started",
                "Sorting",
                "Sorted",
                "All orders received"
            ].some(s => t.includes(s));
        });

        if (!subwaveCell || !statusCell) return;

        const mult = subwaveCell.textContent.trim()
            .match(/^MULT\d+/)?.[0];

        if (!mult) return;

        subwaveStatus[mult] = statusCell.textContent.trim();
    });

    GM_setValue(
        'kisoft_subwave_status',
        subwaveStatus
    );

    const focusStatuses = ["Started", "Sorting", "Sorted", "All orders received"];
    let visibleCount = 0;
    const carrierNeedle = (carrierFilterText || '').toUpperCase().trim();

       

        const waveRows = Array.from(document.querySelectorAll('tr')).filter(tr => {
            const cells = Array.from(tr.querySelectorAll('td'));
            if (!cells.length) return false;
            return cells.some(td => /^MULT\d+/i.test(td.textContent.trim()));
        });

        waveRows.forEach(row => {
            const cells = Array.from(row.querySelectorAll('td'));

            const subwaveCell = cells.find(td => /^MULT\d+/i.test(td.textContent.trim()));
            const mult = subwaveCell?.textContent.trim().match(/^MULT\d+/)?.[0]?.replace(/\s+/g, '');

            const hasFocusStatus = cells.some(td => {
                const txt = td.textContent.trim();
                return focusStatuses.includes(txt) ||
                    txt.includes("Started") ||
                    txt.includes("Sorting") ||
                    txt.includes("Sorted") ||
                    txt.includes("All orders received");
            });

            let matchesCarrier = true;
            if (carrierNeedle) {
                matchesCarrier = false;

                if (mult && mapping[mult] && Array.isArray(mapping[mult].carriers)) {
                    const carriers = mapping[mult].carriers.map(c => String(c).toUpperCase().trim());

                    matchesCarrier = carriers.some(carrier => {
                        if (carrier.includes(carrierNeedle)) return true;
                        if (carrierNeedle === 'SCD' && SCD_GROUP.includes(carrier)) return true;
                        if (carrierNeedle === 'UB-OMNIVA' && UB_OMNIVA_GROUP.includes(carrier)) return true;
                        return false;
                    });
                }
            }

            const passesFocus = !focusModeEnabled || hasFocusStatus;
            const shouldShow = passesFocus && matchesCarrier;

            if (shouldShow) visibleCount++;

            row.classList.toggle('kisoft-focus-hidden', !shouldShow);

            const ariaIndex = row.getAttribute('aria-rowindex');
            const gridRoot =
                row.closest('.dx-datagrid') ||
                row.closest('.af2WebDataControlContainer') ||
                document;

            if (ariaIndex && gridRoot) {
                const parallelRows = Array.from(
                    gridRoot.querySelectorAll(`tr[aria-rowindex="${ariaIndex}"]`)
                ).filter(r => r !== row);

                parallelRows.forEach(pr => {
                    const prCells = Array.from(pr.querySelectorAll('td'));
                    if (!prCells.length) return;
                    if (pr.classList.contains('dx-group-row')) return;

                    const looksLikeCheckboxRow = prCells.every(td => {
                        const txt = td.textContent.trim();
                        const hasInput = td.querySelector('input, .dx-select-checkbox, .dx-checkbox, .dx-command-select');
                        return txt === '' || !!hasInput;
                    });

                    if (!looksLikeCheckboxRow) return;
                    pr.classList.toggle('kisoft-focus-hidden', !shouldShow);
                });
            }
        });

        const btn = document.getElementById('kisoft-focus-btn');
        if (btn) {
            if (focusModeEnabled) {
                btn.textContent = `🎯 Focus mode: ON (${visibleCount})`;
                btn.classList.add('active');
            } else {
                btn.textContent = `🎯 Focus mode: OFF`;
                btn.classList.remove('active');
            }
        }

        const carrierInput = document.getElementById('kisoft-carrier-filter');
        if (carrierInput) {
            carrierInput.style.borderColor = carrierNeedle ? '#1565c0' : '#ccc';
            carrierInput.style.boxShadow = carrierNeedle
                ? '0 0 0 2px rgba(21, 101, 192, 0.12)'
                : 'none';
        }

        setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
        }, 30);
    }
 // =========================================================
    //SYNC Z GRAFANĄ
    // Ten blok pobiera zapisane wcześniej dane z Grafany,
    // przekształca je do struktury mapping używanej przez KiSoft
    // i zapisuje wynik lokalnie.
    // W tym miejscu liczone są m.in.:
    // - carrierzy dla subwave,
    // - rozbicie STD / VIP,
    // - carrierDates,
    // - osrs,
    // - sumG / sumE używane później do obliczenia UPO.
    // Wynikiem jest gotowy model danych do renderu w tabeli.
    // =========================================================

    function hasGrafanaDataChanged(rawData, force = false) {

    const newHash = rawData;

    if (!force && newHash === lastGrafanaDataHash) {
        return false;
    }

    lastGrafanaDataHash = newHash;

    return true;
}
    function syncFromGrafana(
    statusEl,
    isAuto = false,
    forceRefresh = false
) {

    if (statusEl) {
        statusEl.style.color = 'orange';
        statusEl.textContent = isAuto ? 'Auto-Sync...' : 'Loading...';
    }

 const raw = GM_getValue('unified_grafana_data');

if (!raw) {
    if (statusEl) {
        statusEl.textContent = 'No Data from Grafana!';
        statusEl.style.color = 'red';
    }
    return;
}

if (!hasGrafanaDataChanged(raw, forceRefresh)) {

    if (statusEl) {
        statusEl.textContent = 'Auto-Sync: no changes';
        statusEl.style.color = '#388e3c';
    }

    console.log('[Grafana Sync] No data changes - render skipped');

    return;
}

try {
    let gData = JSON.parse(raw);
            if (!Array.isArray(gData)) gData = Object.values(gData);

            mapping = {};
            vipCarriers = {};

            gData.forEach(rec => {
                const subwave = (rec.workGroup || '').replace(/\s+/g, '');
                let type = (rec.orderType || '').toUpperCase().replace(/^B2C-/, '').trim();
               let carrier = rec.carrierId;



                const carrierDate = rec.shipByDate;
                const osr = rec.shipmentGroup;

                const qtyLines = parseInt(rec.valLines, 10) || 0;
                const qtyOrders = parseInt(rec.valOrders, 10) || 0;
                const qtyTasked = parseInt(rec.valTasked, 10) || 0;

                if (!mapping[subwave]) {
                    mapping[subwave] = {
                        carriers: [], std: 0, vip: 0, vipBreakdown: {}, stdBreakdown: {},
                        sumG: 0, sumE: 0, carrierDates: {}, osrs: []
                    };
                    vipCarriers[subwave] = new Set();
                }

                if (carrier && carrier !== '?' && !mapping[subwave].carriers.includes(carrier)) {
                    mapping[subwave].carriers.push(carrier);
                }
                if (carrier && carrierDate && carrierDate !== '?') {
                    if (!mapping[subwave].carrierDates[carrier]) mapping[subwave].carrierDates[carrier] = [];
                    if (!mapping[subwave].carrierDates[carrier].includes(carrierDate)) {
                        mapping[subwave].carrierDates[carrier].push(carrierDate);
                    }
                }
                if (osr && osr !== '?' && !mapping[subwave].osrs.includes(osr)) {
                    mapping[subwave].osrs.push(osr);
                }

                if (!isNaN(qtyLines)) {
                    if (type === 'STD') {
                        mapping[subwave].std += qtyLines;
                        if (carrier) {
                            if (!mapping[subwave].stdBreakdown[carrier]) mapping[subwave].stdBreakdown[carrier] = 0;
                            mapping[subwave].stdBreakdown[carrier] += qtyLines;
                        }
                    } else if (type.includes('VIP')) {
                        mapping[subwave].vip += qtyLines;
                        if (carrier) {
                            vipCarriers[subwave].add(carrier);
                            if (!mapping[subwave].vipBreakdown[carrier]) mapping[subwave].vipBreakdown[carrier] = 0;
                            mapping[subwave].vipBreakdown[carrier] += qtyLines;
                        }
                    } else {
                        mapping[subwave].std += qtyLines;
                    }
                }

                if (!isNaN(qtyTasked)) mapping[subwave].sumG += qtyTasked;
                if (!isNaN(qtyOrders)) mapping[subwave].sumE += qtyOrders;
            });

            saveData();
            recordUpoHistory();

            if (statusEl) {
                statusEl.textContent = `Auto-Sync: 20:00`;
                statusEl.style.color = '#1565c0';
            }

            try {
                mapToKiSoft();
            } catch (e) {
                console.error(e);
            }
        } catch (e) {
            console.error(e);
            if (statusEl) {
                statusEl.textContent = 'Error Data';
                statusEl.style.color = 'red';
            }
        }
    }

// =========================================================
    //HEADER / TAB CHECK / LOAD-SAVE
    // =========================================================
    function addHeader() {
        if (!isOsrOverview()) return;
        const filterPanel = document.getElementById('isc_17');
        if (!filterPanel || filterPanel.querySelector('#kisoftexcel-header')) return;

        const header = document.createElement('div');
        header.id = 'kisoftexcel-header';
        header.style.cssText = `float: right; margin-right: 20px;margin-top: 1px; font-family: Arial, sans-serif; color: black; white-space: nowrap; display: inline-block; vertical-align: middle; text-align: right;`;
        header.innerHTML = `<div style="font-size: 13px; font-weight: bold; margin-bottom: 2px;">KiSoft Carrier Mapper 1.29v
      </div>
                            <div style="font-size: 12px; font-family: monospace; color: black;">vasyl.hospodyn@cevalogistics.com</div>`;

        filterPanel.appendChild(header);
    }

    function isOsrOverview() {
        const activeTabTitle = document.querySelector('.tabButtonTopSelected .af2WebDialogTabTitle');
        if (!activeTabTitle) return false;
        const txt = activeTabTitle.textContent.replace(/\u00a0/g, ' ').trim();
        return txt === 'OSR overview' || txt === 'OSR overview 2' || txt === 'OSR Overview/Capacity' || txt === 'OSR Overview/Capacity 2';
    }

    function saveData() {
        localStorage.setItem('kisoftexcel_mapping', JSON.stringify(mapping));
        let vipToSave = {};
        for (let k in vipCarriers) vipToSave[k] = Array.from(vipCarriers[k]);
        localStorage.setItem('kisoftexcel_vipcarriers', JSON.stringify(vipToSave));
    }

    function loadData() {
        try { mapping = JSON.parse(localStorage.getItem('kisoftexcel_mapping') || '{}'); } catch (e) { mapping = {}; }
        try {
            const vipData = JSON.parse(localStorage.getItem('kisoftexcel_vipcarriers') || '{}');
            vipCarriers = {};
            for (let key in vipData) vipCarriers[key] = new Set(vipData[key]);
        } catch (e) { vipCarriers = {}; }
    }
// =========================================================
    // UI TOOLBAR
    // Uwaga: blok CSS i HTML poniżej jest długi, ale zostawiam go w całości.
    // Komentarze dodane są tam, gdzie logika faktycznie robi coś istotnego.
    // =========================================================
    function addCsvInput() {
        if (!isOsrOverview()) return;
        const filterPanel = document.getElementById('isc_17');
        if (!filterPanel) return;

        if (!document.getElementById('kisoft-custom-buttons-style')) {
            const s = document.createElement('style');
            s.id = 'kisoft-custom-buttons-style';
            s.innerHTML = `
                .kisoft-del-btn { position: relative; border-radius: 6px; width: 125px; height: 34px; cursor: pointer; display: inline-flex; align-items: center; border: 1px solid #cc0000; background-color: #e50000; overflow: hidden; margin-left: 270px; vertical-align: middle; margin-top: 3px; }
                .kisoft-del-btn, .kisoft-del-btn__icon, .kisoft-del-btn__text { transition: all 0.3s; }
                .kisoft-del-btn .kisoft-del-btn__text { transform: translateX(10px); color: #fff; font-weight: 600; font-family: Arial, sans-serif; font-size: 13px; }
                .kisoft-del-btn .kisoft-del-btn__icon { position: absolute; transform: translateX(85px); height: 100%; width: 34px; background-color: #cc0000; display: flex; align-items: center; justify-content: center; }
                .kisoft-del-btn .svg { width: 18px; }
                .kisoft-del-btn:hover { background: #cc0000; }
                .kisoft-del-btn:hover .kisoft-del-btn__text { color: transparent; }
                .kisoft-del-btn:hover .kisoft-del-btn__icon { width: 118px; transform: translateX(0); }
                .kisoft-del-btn:active .kisoft-del-btn__icon { background-color: #b20000; }
                .kisoft-del-btn:active { border: 1px solid #b20000; }
                @keyframes btn-press { 0% { transform: scale(1); } 40% { transform: scale(0.92); filter: brightness(0.9); } 100% { transform: scale(1); filter: brightness(1); } }
                .btn-anim-click { animation: btn-press 0.2s ease-out forwards; }
                .kisoft-sync-btn { --primary: #1565c0; --neutral-1: #f7f8f7; --neutral-2: #e7e7e7; --radius: 6px; cursor: pointer; border-radius: var(--radius); text-shadow: 0 1px 1px rgba(0, 0, 0, 0.3); border: 1px solid #ccc; box-shadow: 0 0.5px 0.5px 1px rgba(255, 255, 255, 0.2), 0 2px 4px rgba(0, 0, 0, 0.1); display: inline-flex; align-items: center; justify-content: center; position: relative; transition: all 0.3s ease; min-width: 140px; padding: 0 10px; height: 34px; margin-left: 10px; vertical-align: middle; margin-top: 3px; font-family: Arial, sans-serif; font-style: normal; font-size: 13px; font-weight: 600; color: #1565c0; background: white; }
                .kisoft-sync-btn:hover { transform: scale(1.02); box-shadow: 0 0 1px 2px rgba(255, 255, 255, 0.3), 0 4px 8px rgba(0, 0, 0, 0.2); }
                .kisoft-sync-btn:active, .kisoft-sync-btn:focus { transform: scale(1); outline: none; }
                .kisoft-sync-btn:after { content: ""; position: absolute; inset: 0; border-radius: var(--radius); border: 1px solid transparent; background: linear-gradient(var(--neutral-1), var(--neutral-2)) padding-box, linear-gradient(to bottom, rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.45)) border-box; z-index: 0; transition: all 0.4s ease; }
                .kisoft-sync-btn:hover::after { transform: scale(1.02, 1.05); }
                .kisoft-sync-btn::before { content: ""; inset: 2px; position: absolute; background: linear-gradient(to top, var(--neutral-1), var(--neutral-2)); border-radius: 6px; filter: blur(0.5px); z-index: 2; }
                .kisoft-state p { display: flex; align-items: center; justify-content: center; margin: 0; }
                .kisoft-state .icon { position: absolute; left: 0; top: 0; bottom: 0; margin: auto; transform: scale(0.9); transition: all 0.3s ease; display: flex; align-items: center; justify-content: center; color: #1565c0; }
                .kisoft-state .icon svg { overflow: visible; width: 1.2em; height: 1.2em; }
                .kisoft-outline { position: absolute; border-radius: inherit; overflow: hidden; z-index: 1; opacity: 0; transition: opacity 0.4s ease; inset: -1px; }
                .kisoft-outline::before { content: ""; position: absolute; inset: -100%; background: conic-gradient(from 180deg, transparent 60%, white 80%, transparent 100%); animation: spin 2s linear infinite; animation-play-state: paused; }
                @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                .kisoft-sync-btn:hover .kisoft-outline { opacity: 1; }
                .kisoft-sync-btn:hover .kisoft-outline::before { animation-play-state: running; }
                .kisoft-state p span { display: block; opacity: 0; animation: slideDown 0.8s ease forwards calc(var(--i) * 0.03s); color: #1565c0; }
                .kisoft-sync-btn:hover p span { opacity: 1; animation: wave 0.5s ease forwards calc(var(--i) * 0.02s); }
                .kisoft-sync-btn:focus p span { opacity: 1; animation: disapear 0.6s forwards calc(var(--i) * 0.03s); }
                @keyframes wave { 30% { opacity: 1; transform: translateY(2px); } 50% { opacity: 1; transform: translateY(-1px); color: var(--primary); } 100% { opacity: 1; transform: translateY(0); } }
                @keyframes slideDown { 0% { opacity: 0; transform: translateY(-10px) translateX(2px) rotate(-90deg); color: var(--primary); filter: blur(2px); } 30% { opacity: 1; transform: translateY(2px); filter: blur(0); } 50% { opacity: 1; transform: translateY(-1px); } 100% { opacity: 1; transform: translateY(0); } }
                @keyframes disapear { from { opacity: 1; } to { opacity: 0; transform: translateX(2px) translateY(10px); color: var(--primary); filter: blur(2px); } }
                .state--default .icon svg { animation: land 0.6s ease forwards; }
                .kisoft-sync-btn:hover .state--default .icon { transform: rotate(180deg) scale(1); }
                .kisoft-sync-btn:focus .state--default svg { animation: spinAway 0.8s linear forwards; }
                .kisoft-sync-btn:focus .state--default .icon { transform: rotate(0) scale(1); }
                @keyframes spinAway { 0% { opacity: 1; transform: rotate(0deg); } 60% { opacity: 1; transform: rotate(360deg) scale(0.5); } 100% { opacity: 0; transform: rotate(720deg) scale(0); } }
                @keyframes land { 0% { transform: scale(0); opacity: 0; filter: blur(2px); } 100% { transform: scale(1); opacity: 1; filter: blur(0); } }
                .state--default .icon:before { display: none; }
                .kisoft-state { padding-left: 25px; z-index: 2; display: flex; position: relative; }
                .state--default span:nth-child(4) { margin-right: 5px; }
                .state--sent { display: none; }
                .state--sent svg { transform: scale(1); margin-right: 5px; }
                .kisoft-sync-btn:focus .state--default { position: absolute; }
                .kisoft-sync-btn:focus .state--sent { display: flex; }
                .kisoft-sync-btn:focus .state--sent span { opacity: 0; animation: slideDown 0.8s ease forwards calc(var(--i) * 0.2s); }
                .kisoft-sync-btn:focus .state--sent .icon svg { opacity: 0; animation: appear 1.2s ease forwards 0.8s; }
                @keyframes appear { 0% { opacity: 0; transform: scale(2) rotate(-40deg); color: var(--primary); filter: blur(2px); } 30% { opacity: 1; transform: scale(0.6); filter: blur(1px); } 50% { opacity: 1; transform: scale(1.1); filter: blur(0); } 100% { opacity: 1; transform: scale(1); } }
                .kisoft-paste-input { --primary: #1565c0; --radius: 6px; height: 34px; width: 140px; padding-left: 10px; padding-right: 10px; padding-top: 6px; margin-left: 10px; box-sizing: border-box; vertical-align: middle; display: inline-block; margin-top: 3px; border: 1px solid #ccc; border-radius: var(--radius); background: white; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); color: var(--primary); font-family: Arial, sans-serif; font-size: 13px; font-weight: 600; text-align: left; resize: none; overflow: hidden; white-space: nowrap; transition: all 0.3s ease; }
                .kisoft-paste-input:hover { transform: scale(1.02); box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2); }
                .kisoft-paste-input:focus { border-color: var(--primary); outline: none; transform: scale(1); box-shadow: 0 0 0 2px rgba(21, 101, 192, 0.1); }
                .kisoft-paste-input::placeholder { color: #90caf9; font-weight: normal; }
                @keyframes blink-red { 0% { background-color: #ff0000; } 50% { background-color: #ff8888; } 100% { background-color: #ff0000; } }
                .blink-alert { animation: blink-red ${BLINK_SPEED_SECONDS}s infinite; color: white !important; font-weight: bold; border-radius: 7px; }

            .kisoft-focus-hidden {
    visibility: collapse !important;
}

.kisoft-focus-hidden > td {
    padding-top: 0 !important;
    padding-bottom: 0 !important;
    border-top-width: 0 !important;
    border-bottom-width: 0 !important;
    height: 0 !important;
    line-height: 0 !important;
    font-size: 0 !important;
    overflow: hidden !important;
}

.kisoft-simple-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;

    height:34px;
    line-height:34px;

    margin-left:10px;
    margin-top:3px;

    vertical-align:middle;

    color:#1565C0;
    font-family:Arial,sans-serif;
    font-size:13px;
    font-weight:bold;

    border-radius:6px;

    border:1px solid #d6d6d6;

    background:
        linear-gradient(
            to bottom,
            #ffffff 0%,
            #f4f4f4 45%,
            #e3e3e3 100%
        );

    box-shadow:
        inset 0 1px 0 rgba(255,255,255,.9),
        0 3px 6px rgba(0,0,0,.18);

    transition:
        transform .15s,
        box-shadow .15s,
        filter .15s;
}

.kisoft-simple-btn:hover{
    filter:brightness(1.04);

    box-shadow:
        inset 0 1px 0 rgba(255,255,255,.9),
        0 5px 10px rgba(0,0,0,.22);
}

.kisoft-simple-btn:active{
    transform:translateY(1px);

    box-shadow:
        inset 0 2px 4px rgba(0,0,0,.15),
        0 1px 2px rgba(0,0,0,.15);
}

.kisoft-simple-btn.active{
    background:
        linear-gradient(
            to bottom,
            #1ad416,
            #18c314
        );

    color:white;
    border-color:#169113;
}
.kisoft-infeed-btn.active{
    background:linear-gradient(
        to bottom,
        #fce600,
       #e4d211
    );

    color:white;
    border-color:#c1b20f;
}
.kisoft-automation-btn.active{
    background:linear-gradient(
        to bottom,
       #fce600,
       #e4d211
    );

    color:white;
    border-color:#c1b20f;
}
                #kisoft-upo-trend-panel{.kisoft-trend-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 8px;
}

.kisoft-trend-header h3 {
    margin: 0 !important;
}

.kisoft-reset-history-btn {
    border: 1px solid #c62828;
    background: #fff;
    color: #c62828;
    border-radius: 5px;
    padding: 4px 8px;
    font-size: 11px;
    font-weight: bold;
    cursor: pointer;
    white-space: nowrap;
}
#kisoft-show-upo-history {
    background: #B0E0E6;
    color: #008080;
    border: 1px solid #008080;
}

.kisoft-reset-history-btn:hover {
    background: #c62828;
    color: white;
}
#kisoft-show-upo-history:hover {
    background: #008080;
    color: #fff;
}
                    position:absolute;
                    z-index:999999;
                    background:rgba(255,255,255,.98);
                    border:1px solid #bbb;
                    border-radius:8px;
                    box-shadow:0 6px 18px rgba(0,0,0,.18);
                    padding:10px 12px;
                    width:430px;
                    max-height:420px;
                    overflow:auto;
                    font-family:Arial,sans-serif;
                    display:none;
                }
                #kisoft-upo-trend-panel h3{
                    margin:0 0 8px 0;font-size:13px;color:#1565c0
                }
                .kisoft-trend-row{
                    display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid #eee;
                    font-size:12px;align-items:center;
                }
                .kisoft-trend-row:last-child{border-bottom:none}
                .kisoft-trend-left{font-weight:bold;color:#222;min-width:94px}
                .kisoft-trend-mid{color:#333;flex:1}
                .kisoft-trend-delta-up{color:#2e7d32;font-weight:bold}
                .kisoft-trend-delta-down{color:#c62828;font-weight:bold}
                .kisoft-trend-delta-flat{color:#607d8b;font-weight:bold}
                .kisoft-trend-muted{color:#888}
                .kisoft-upo-debug-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,.45);
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
}

.kisoft-upo-debug-modal {
    width: min(900px, 92vw);
    max-height: 85vh;
    background: #fff;
    color: #222;
    border-radius: 10px;
    box-shadow: 0 10px 40px rgba(0,0,0,.35);
    overflow: hidden;
    font-family: Arial, sans-serif;
}

.kisoft-upo-debug-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    background: #f3f3f3;
    border-bottom: 1px solid #ddd;
}

.kisoft-upo-debug-header button {
    border: 0;
    background: transparent;
    cursor: pointer;
    font-size: 18px;
}

.kisoft-upo-debug-body {
    padding: 15px;
    overflow-y: auto;
    max-height: 75vh;
}

.kisoft-upo-debug-osr {
    margin-bottom: 25px;
}

.kisoft-upo-debug-osr h4 {
    margin: 0 0 10px;
}

.kisoft-upo-debug-hour {
    border: 1px solid #ddd;
    border-radius: 7px;
    margin-bottom: 10px;
    overflow: hidden;
}

.kisoft-upo-debug-hour-title {
    display: flex;
    justify-content: space-between;
    padding: 8px 10px;
    background: #f7f7f7;
    border-bottom: 1px solid #ddd;
}

.kisoft-upo-debug-item {
    display: grid;
    grid-template-columns: 80px 80px 1fr;
    gap: 10px;
    padding: 6px 10px;
    border-bottom: 1px solid #eee;
    font-size: 13px;
}

.kisoft-upo-debug-item:last-child {
    border-bottom: 0;
}
.kisoft-upo-debug-osr h4 {
    margin: 0 0 10px;
    color: #1565c0;
    font-weight: 700;
    font-size: 15px;
}
            `;
            document.head.appendChild(s);
        }

        function triggerAnimation(btn) {
            btn.classList.remove('btn-anim-click');
            void btn.offsetWidth;
            btn.classList.add('btn-anim-click');
        }

        if (!filterPanel.querySelector('#kisoftexcelclear')) {
            const clearBtn = document.createElement('button');
            clearBtn.id = 'kisoftexcelclear';
            clearBtn.className = 'kisoft-del-btn';
            clearBtn.type = 'button';

            clearBtn.innerHTML = `
              <span class="kisoft-del-btn__text">Clear Data</span>
              <span class="kisoft-del-btn__icon">
                <svg class="svg" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
                  <path d="M112,112l20,320c.95,18.49,14.4,32,32,32H348c17.67,0,30.87-13.51,32-32l20-320" style="fill:none;stroke:#fff;stroke-linecap:round;stroke-linejoin:round;stroke-width:34px"></path>
                  <line style="stroke:#fff;stroke-linecap:round;stroke-miterlimit:10;stroke-width:34px" x1="80" x2="432" y1="112" y2="112"></line>
                  <path d="M192,112V72h0a23.93,23.93,0,0,1,24-24h80a23.93,23.93,0,0,1,24,24h0v40" style="fill:none;stroke:#fff;stroke-linecap:round;stroke-linejoin:round;stroke-width:34px"></path>
                  <line style="fill:none;stroke:#fff;stroke-linecap:round;stroke-linejoin:round;stroke-width:32px" x1="256" x2="256" y1="176" y2="400"></line>
                  <line style="fill:none;stroke:#fff;stroke-linecap:round;stroke-linejoin:round;stroke-width:32px" x1="184" x2="192" y1="176" y2="400"></line>
                  <line style="fill:none;stroke:#fff;stroke-linecap:round;stroke-linejoin:round;stroke-width:32px" x1="328" x2="320" y1="176" y2="400"></line>
                </svg>
              </span>
            `;

            clearBtn.onclick = () => {
                triggerAnimation(clearBtn);
                mapping = {};
                vipCarriers = {};
                localStorage.removeItem('kisoftexcel_mapping');
                localStorage.removeItem('kisoftexcel_vipcarriers');
                try {
                    mapToKiSoft();
                } catch (e) {
                    console.error(e);
                }
                const pasteArea = document.getElementById('kisoftexcelpaste');
                if (pasteArea) pasteArea.value = '';
            };

            filterPanel.appendChild(clearBtn);
        }

        if (!filterPanel.querySelector('#kisoftexcelpaste')) {
            const pasteArea = document.createElement('textarea');
            pasteArea.placeholder = '📥 Insert WMS Data';
            pasteArea.id = 'kisoftexcelpaste';
            pasteArea.className = 'kisoft-paste-input';

            pasteArea.addEventListener('paste', e => {
                e.preventDefault();
                const text = e.clipboardData.getData('text');
                if (!text.trim()) return;
                parseCsvText(text);
                try {
                    mapToKiSoft();
                } catch (e) {
                    console.error(e);
                }
                saveData();
                recordUpoHistory();
                pasteArea.style.borderColor = '#4caf50';
                setTimeout(() => { pasteArea.style.borderColor = '#ccc'; }, 1300);
            });
            filterPanel.appendChild(pasteArea);
        }

        if (!filterPanel.querySelector('#grafana-sync-btn')) {
            const syncBtn = document.createElement('button');
            syncBtn.id = 'grafana-sync-btn';
            syncBtn.className = 'kisoft-sync-btn';

            syncBtn.innerHTML = `
              <div class="kisoft-outline"></div>
              <div class="kisoft-state state--default">
                <div class="icon">
                  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <g style="filter: url(#shadow)">
                       <path fill="currentColor" d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"></path>
                    </g>
                    <defs>
                      <filter id="shadow"><fedropshadow dx="0" dy="1" stdDeviation="0.6" flood-opacity="0.5"></fedropshadow></filter>
                    </defs>
                  </svg>
                </div>
                <p>
                  <span style="--i:0">S</span><span style="--i:1">y</span><span style="--i:2">n</span><span style="--i:3">c</span><span style="--i:4">&nbsp;</span><span style="--i:5">G</span><span style="--i:6">r</span><span style="--i:7">a</span><span style="--i:8">f</span><span style="--i:9">a</span><span style="--i:10">n</span><span style="--i:11">a</span>
                </p>
              </div>
              <div class="kisoft-state state--sent">
                <div class="icon">
                  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <g style="filter: url(#shadow)">
                       <path fill="currentColor" d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"></path>
                    </g>
                  </svg>
                </div>
                <p>
                  <span style="--i:5">S</span><span style="--i:6">y</span><span style="--i:7">n</span><span style="--i:8">c</span>
                </p>
              </div>
            `;

            const statusSpan = document.createElement('span');
            statusSpan.id = 'grafana-sync-status';
            statusSpan.style.cssText = 'margin-left: 8px; font-weight: bold; color:#1565c0; font-size: 11px; display: inline-block; vertical-align: middle;margin-top: 6px;';
            statusSpan.textContent = 'Auto-Sync: 20:00';

           syncBtn.onclick = (e) => {
    e.preventDefault();
    syncBtn.focus();
    syncBtn.style.pointerEvents = 'none';

    syncFromGrafana(
        statusSpan,
        false,
        true
    );

    setTimeout(() => {
        syncBtn.blur();
        syncBtn.style.pointerEvents = 'auto';
    }, 2000);
};

            filterPanel.appendChild(syncBtn);
            filterPanel.appendChild(statusSpan);

            if (!filterPanel.querySelector('#kisoft-carrier-filter')) {
                const carrierInput = document.createElement('input');
                carrierInput.type = 'text';
                carrierInput.id = 'kisoft-carrier-filter';
                carrierInput.placeholder = '🔍 Carrier filter';
                carrierInput.className = 'kisoft-paste-input';

                carrierInput.style.width = '125px';
                carrierInput.style.minWidth = '125px';
                carrierInput.style.maxWidth = '125px';
                carrierInput.style.marginLeft = '10px';

                carrierInput.style.height = '34px';
                carrierInput.style.lineHeight = '34px';
                carrierInput.style.paddingTop = '0px';
                carrierInput.style.paddingBottom = '0px';
                carrierInput.style.verticalAlign = 'middle';
                carrierInput.style.boxSizing = 'border-box';

                carrierInput.addEventListener('input', () => {
                    carrierFilterText = carrierInput.value.trim();
                    applyCombinedFilters();
                    if (upoTrendPanelOpen) renderUpoTrendPanel();
                });

                filterPanel.appendChild(carrierInput);
            }

            if (!filterPanel.querySelector('#kisoft-focus-btn')) {
                const focusBtn = document.createElement('button');
                focusBtn.id = 'kisoft-focus-btn';
                focusBtn.className = 'kisoft-simple-btn';
                focusBtn.textContent = '🎯 Focus: OFF';

                focusBtn.onclick = (e) => {
                    e.preventDefault();
                    focusModeEnabled = !focusModeEnabled;
                    applyCombinedFilters();
                    addOsrSummaryPanel();
                    if (upoTrendPanelOpen) renderUpoTrendPanel();
                };

                filterPanel.appendChild(focusBtn);
            }

            if (!filterPanel.querySelector('#kisoft-upo-trend-btn')) {
                const trendBtn = document.createElement('button');
                trendBtn.id = 'kisoft-upo-trend-btn';
                trendBtn.className = 'kisoft-simple-btn';
                trendBtn.textContent = '📈 UPO Trend';

                trendBtn.onclick = (e) => {
                    e.preventDefault();
                    upoTrendPanelOpen = !upoTrendPanelOpen;

                    const panel = ensureUpoTrendPanel();
                    if (upoTrendPanelOpen) {
                        positionTrendPanelUnderButton(trendBtn);
                        renderUpoTrendPanel();
                        panel.style.display = 'block';
                        trendBtn.classList.add('active');
                    } else {
                        panel.style.display = 'none';
                        trendBtn.classList.remove('active');
                    }
                };

                filterPanel.appendChild(trendBtn);
            }

            if (!autoSyncInterval) {
                setTimeout(() => syncFromGrafana(statusSpan, true), 2000);
                autoSyncInterval = setInterval(() => { syncFromGrafana(statusSpan, true); }, AUTO_SYNC_MS);
                autoSyncCountdownInterval = setInterval(() => {
                    const el = document.getElementById('grafana-sync-status');
                    if (!el) return;
                    const text = el.textContent;
                    const match = text.match(/Auto-Sync:\s*(\d{2}):(\d{2})/);
                    if (!match) return;
                    let mm = parseInt(match[1], 10), ss = parseInt(match[2], 10);
                    if (mm === 0 && ss === 0) {
                        el.textContent = `Auto-Sync: 00:00`;
                        return;
                    }
                    let total = mm * 60 + ss - 1;
                    if (total < 0) total = 0;
                    const newMM = String(Math.floor(total / 60)).padStart(2, '0');
                    const newSS = String(total % 60).padStart(2, '0');
                    el.textContent = `Auto-Sync: ${newMM}:${newSS}`;
                }, 1000);
            }
        }
    }
 // =========================================================
    // PARSE CSV / PASTE
    // =========================================================
    function parseCsvText(text) {
        mapping = {};
        vipCarriers = {};
        const lines = text.split('\n');
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const cols = line.split(/\t|,/);
            if (cols.length < 10) continue;
            const subwave = cols[0].trim().replace(/\s+/g, '');
            let type = cols[1].trim().replace(/^B2C-/, '').trim().toUpperCase();
            const carrier = cols[2].trim();
            const carrierDate = cols[3] ? cols[3].trim() : null;
            const itemsE = parseInt(cols[5] ? cols[5].trim() : '0', 10) || 0;
            const items = parseInt(cols[6] ? cols[6].trim() : '0', 10) || 0;
            const itemsG = parseInt(cols[7] ? cols[7].trim() : '0', 10) || 0;
            const osr = cols[9] ? cols[9].trim() : null;

            if (subwave.startsWith('MULT')) {
                if (!mapping[subwave]) {
                    mapping[subwave] = { carriers: [], std: 0, vip: 0, vipBreakdown: {}, stdBreakdown: {}, sumG: 0, sumE: 0, carrierDates: {}, osrs: [] };
                    vipCarriers[subwave] = new Set();
                }
                if (carrier && !mapping[subwave].carriers.includes(carrier)) mapping[subwave].carriers.push(carrier);
                if (carrier && carrierDate) {
                    if (!mapping[subwave].carrierDates[carrier]) mapping[subwave].carrierDates[carrier] = [];
                    if (!mapping[subwave].carrierDates[carrier].includes(carrierDate)) mapping[subwave].carrierDates[carrier].push(carrierDate);
                }
                if (osr && !mapping[subwave].osrs.includes(osr)) mapping[subwave].osrs.push(osr);
                if (!isNaN(items)) {
                    if (type === 'STD') {
                        mapping[subwave].std += items;
                        if (carrier) {
                            if (!mapping[subwave].stdBreakdown[carrier]) mapping[subwave].stdBreakdown[carrier] = 0;
                            mapping[subwave].stdBreakdown[carrier] += items;
                        }
                    } else if (type.includes('VIP')) {
                        mapping[subwave].vip += items;
                        vipCarriers[subwave].add(carrier);
                        if (carrier) {
                            if (!mapping[subwave].vipBreakdown[carrier]) mapping[subwave].vipBreakdown[carrier] = 0;
                            mapping[subwave].vipBreakdown[carrier] += items;
                        }
                    }
                }
                if (!isNaN(itemsG)) mapping[subwave].sumG += itemsG;
                if (!isNaN(itemsE)) mapping[subwave].sumE += itemsE;
            }
        }
        saveData();
        recordUpoHistory();
    }
    // ============================================================
// KISOFT RENDER DEBOUNCE
// Łączy wiele szybkich zmian DOM w jedno renderowanie.
// ============================================================

// ============================================================
// SAFE KISOFT RENDER DEBOUNCE
// Łączy wiele szybkich zmian DOM w jedno renderowanie.
// ============================================================

let kiSoftRenderTimeout = null;

function scheduleKiSoftRender(delay = 250) {

    // Resetujemy timer przy każdej kolejnej zmianie DOM.
    clearTimeout(kiSoftRenderTimeout);

    kiSoftRenderTimeout = setTimeout(() => {

        // Renderowanie tylko na właściwym widoku OSR.
        if (!isOsrOverview()) {
            return;
        }

        try {

            console.log(
                '[KiSoft] Debounced render started'
            );

            // Czekamy na pełne załadowanie wierszy KiSoft,
            // a następnie uruchamiamy mapToKiSoft().
            waitForKiSoftRows();

        } catch (error) {

            console.error(
                '[KiSoft] Debounced render error:',
                error
            );
        }

    }, delay);
}
     // =========================================================
    // GŁÓWNE MAPOWANIE DO DOM
    // To jest krytyczny blok. Jeśli "sypie się lista DOM",
    // to właśnie tutaj najczęściej siedzi przyczyna:
    // - czyszczenie cell.innerHTML,
    // - wielokrotny render tej samej komórki,
    // - złe rozpoznanie komórek MULT,
    // - render w niepełnym DOM po refreshu gridu.
    // =========================================================
function waitForKiSoftRows(attempt = 0) {
    if (!isOsrOverview()) return;

    const hasRows = Array.from(document.querySelectorAll('td'))
        .some(td => /^MULT\d+$/i.test(td.textContent.trim()));

    if (hasRows) {
        try {
            mapToKiSoft();
        } catch (e) {
            console.error('[KiSoft] mapToKiSoft error:', e);
        }
        return;
    }

    // Maksymalnie 20 prób × 500 ms = 10 sekund
    if (attempt < 20) {
        setTimeout(() => waitForKiSoftRows(attempt + 1), 500);
    } else {
        console.warn('[KiSoft] Nie znaleziono wierszy MULT po 10 sekundach.');
    }
}
    function mapToKiSoft() {
        if (!isOsrOverview()) return;

        if (!document.getElementById('kisoft-critical-style')) {
            const s = document.createElement('style');
            s.id = 'kisoft-critical-style';
            s.innerHTML = `
                @keyframes text-pulse-critical { 35%, 100% { opacity: 1; } 60% { opacity: 0.3; } }
                .carrier-critical { animation: text-pulse-critical 2.8s infinite ease-in-out !important; display: inline-block; color: #CC0000 !important; font-weight: 900 !important; cursor: help; }
            `;
            document.head.appendChild(s);
        }

        let totesColIndex = -1;
        document.querySelectorAll('td, th').forEach(el => {
            if (el.textContent.trim() === 'Totes in group') {
                const tr = el.closest('tr');
                if (tr) totesColIndex = Array.from(tr.children).indexOf(el);
            }
        });

        const cells = Array.from(document.querySelectorAll('td')).filter(td => /^MULT\d+$/i.test(td.textContent.trim()));

        const now = new Date();
        const currMins = now.getHours() * 60 + now.getMinutes();
        const midnightToday = new Date();
        midnightToday.setHours(0, 0, 0, 0);

        const parseDateStr = (dStr) => {
            if (!dStr) return null;
            dStr = dStr.trim();
            let y, m, d;
            if (/^\d{4}-\d{2}-\d{2}$/.test(dStr)) {
                [y, m, d] = dStr.split('-').map(Number);
            } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(dStr)) {
                [d, m, y] = dStr.split('/').map(Number);
            } else if (/^\d{2}\.\d{2}\.\d{4}$/.test(dStr)) {
                [d, m, y] = dStr.split('.').map(Number);
            } else {
                return null;
            }
            return new Date(y, m - 1, d);
        };

        const checkD2Condition = (c, datesList) => {
            if (!datesList) return false;
            return datesList.some(d => {
                const dt = parseDateStr(d);
                if (!dt) return false;
                if (dt.getTime() < midnightToday.getTime()) return true;
                if (dt.getTime() === midnightToday.getTime() && CARRIER_CUTOFFS[c]) {
                    let [h, m] = CARRIER_CUTOFFS[c].split(':').map(Number);
                    let cutoffMins = h * 60 + m;
                    if (currMins > cutoffMins) return true;
                }
                return false;
            });
        };

        const checkSLACondition = (c, datesList) => {
            if (!datesList) return false;
            return datesList.some(d => {
                const dt = parseDateStr(d);
                if (!dt) return false;
                if (dt.getTime() !== midnightToday.getTime()) return false;
                if (CARRIER_CUTOFFS[c]) {
                    let [h, m] = CARRIER_CUTOFFS[c].split(':').map(Number);
                    let cutoffMins = h * 60 + m;
                    return currMins <= cutoffMins;
                }
                return true;
            });
        };

        const checkNDCondition = (datesList) => {
            if (!datesList) return false;
            return datesList.some(d => {
                const dt = parseDateStr(d);
                if (!dt) return false;
                return dt.getTime() > midnightToday.getTime();
            });
        };

        const checkCriticalCondition = (c, datesList) => {
            if (!datesList || !CARRIER_CUTOFFS[c]) return false;
            return datesList.some(d => {
                const dt = parseDateStr(d);
                if (!dt) return false;
                if (dt.getTime() > midnightToday.getTime()) return false;
                let [h, m] = CARRIER_CUTOFFS[c].split(':').map(Number);
                let cutoffMins = h * 60 + m;
                let diff = cutoffMins - currMins;
                return diff >= 0 && diff <= 45;
            });
        };

        let criticalRowsToTop = [];

        for (let cell of cells) {
            const rawSubwave = cell.textContent.trim().match(/^MULT\d+/)?.[0];
            if (!rawSubwave) continue;
            const subwave = rawSubwave.replace(/\s+/g, '');
            const rowParent = cell.closest('tr');
            let isRowCritical = false;

            cell.innerHTML = '';
            const multCopyBtn = document.createElement('span');
            multCopyBtn.textContent = rawSubwave;
            Object.assign(multCopyBtn.style, { cursor: 'pointer', color: 'black', padding: '2px 4px', borderRadius: '4px', transition: 'all 0.2s', display: 'inline-block' });
            multCopyBtn.title = "Click to copy the subwave ID";

            multCopyBtn.onmouseenter = () => multCopyBtn.style.backgroundColor = '#e3f2fd';
            multCopyBtn.onmouseleave = () => multCopyBtn.style.backgroundColor = 'transparent';

            multCopyBtn.onclick = (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(rawSubwave).then(() => {
                    const originalWidth = multCopyBtn.offsetWidth;
                    multCopyBtn.style.minWidth = `${originalWidth}px`;
                    multCopyBtn.textContent = 'copy';
                    multCopyBtn.style.color = '#2e7d32';
                    multCopyBtn.style.textDecoration = 'none';
                    multCopyBtn.style.backgroundColor = '#c8e6c9';

                    setTimeout(() => {
                        multCopyBtn.textContent = rawSubwave;
                        multCopyBtn.style.color = 'black';
                        multCopyBtn.style.backgroundColor = 'transparent';
                        multCopyBtn.style.minWidth = 'auto';
                    }, 500);
                }).catch(err => console.error('Clipboard error:', err));
            };

            cell.appendChild(multCopyBtn);

            if (mapping[subwave]) {
                if (mapping[subwave].osrs.length > 0) {
                    const osrDisplay = mapping[subwave].osrs.map(osrCode => {
                        const digits = osrCode.match(/\d{3}$/);
                        return digits ? `OSR*${digits[0]}` : osrCode;
                    }).join(" / ");
                    const osrSpan = document.createElement("span");
                    osrSpan.textContent = "  " + osrDisplay + " ";
                    osrSpan.style.color = "black";
                    osrSpan.style.fontWeight = "bold";
                    cell.appendChild(osrSpan);
                }
                let { sumG, sumE } = mapping[subwave];
                let upo = (sumG && sumE) ? (sumG / sumE).toFixed(2) : '-';
                const sepSpan = document.createElement('span');
                sepSpan.textContent = ' │ ';
                sepSpan.style.color = 'black';
                sepSpan.style.fontWeight = 'bold';
                sepSpan.style.fontSize = '14px';
                sepSpan.style.verticalAlign = 'middle';
                cell.appendChild(sepSpan);
                const upoSpan = document.createElement('span');
                upoSpan.textContent = ' ➭UPO: ' + upo + ' ';
                upoSpan.style.color = '#008800';
                upoSpan.style.fontWeight = 'bold';
                cell.appendChild(upoSpan);

                if (mapping[subwave].std > 0) {
                    const sep = document.createElement('span');
                    sep.textContent = ' │ ';
                    sep.style.color = 'black';
                    sep.style.fontWeight = 'bold';
                    cell.appendChild(sep);

                    const std = document.createElement('span');
                    std.textContent = 'STD';
                    Object.assign(std.style, { color: "#fff", background: "#1976d2", fontWeight: 'bold', fontSize: '11px', borderRadius: '7px', padding: '2px 6px', lineHeight: '1.5', verticalAlign: 'middle' });
                    if (mapping[subwave].stdBreakdown) {
                        let tooltipText = [];
                        for (const [c, count] of Object.entries(mapping[subwave].stdBreakdown)) tooltipText.push(`${c}: ${count}`);
                        if (tooltipText.length > 0) {
                            std.title = tooltipText.join('\n');
                            std.style.cursor = 'help';
                        }
                    }
                    cell.appendChild(std);

                    const eq = document.createElement('span');
                    eq.textContent = ' = ' + mapping[subwave].std;
                    eq.style.color = '#008800';
                    eq.style.fontWeight = 'bold';
                    eq.style.display = 'inline-block';
                    eq.style.minWidth = '35px';
                    eq.style.textAlign = 'left';
                    cell.appendChild(eq);
                }

                if (mapping[subwave].vip > 0) {
                    const sep = document.createElement('span');
                    sep.textContent = ' │ ';
                    sep.style.color = 'black';
                    sep.style.fontWeight = 'bold';
                    cell.appendChild(sep);

                    const vip = document.createElement('span');
                    vip.textContent = 'VIP';
                    Object.assign(vip.style, { color: "#fff", background: "#d32f2f", fontWeight: 'bold', fontSize: '11px', borderRadius: '7px', padding: '2px 6px', lineHeight: '1.5', verticalAlign: 'middle' });
                    if (mapping[subwave].vipBreakdown) {
                        let tooltipText = [];
                        for (const [c, count] of Object.entries(mapping[subwave].vipBreakdown)) tooltipText.push(`${c}: ${count}`);
                        if (tooltipText.length > 0) {
                            vip.title = tooltipText.join('\n');
                            vip.style.cursor = 'help';
                        }
                    }
                    cell.appendChild(vip);

                    const eq = document.createElement('span');
                    eq.textContent = ' = ' + mapping[subwave].vip;
                    eq.style.color = '#008800';
                    eq.style.fontWeight = 'bold';
                    eq.style.display = 'inline-block';
                    eq.style.minWidth = '35px';
                    eq.style.textAlign = 'left';
                    cell.appendChild(eq);
                }

                const arrow = document.createElement('span');
                arrow.textContent = '➭ ';
                arrow.style.color = '#007';
                arrow.style.fontWeight = 'bold';
                cell.appendChild(arrow);
            }

            if (mapping[subwave]?.carriers?.length) {
                const hasSCD = mapping[subwave].carriers.some(carrier => SCD_GROUP.includes(carrier));
                const hasUBOMNIVA = mapping[subwave].carriers.some(carrier => UB_OMNIVA_GROUP.includes(carrier));
                const otherCarriersSet = new Set();

                mapping[subwave].carriers.forEach(carrier => {
                    if (!SCD_GROUP.includes(carrier) && !UB_OMNIVA_GROUP.includes(carrier)) {
                        otherCarriersSet.add(carrier);
                    }
                });

                const displayList = [];
                if (hasSCD) displayList.push("SCD");
                if (hasUBOMNIVA) displayList.push("UB-OMNIVA");
                displayList.push(...otherCarriersSet);
                const uniqueDisplayList = [...new Set(displayList)];

                uniqueDisplayList.forEach((carrier, idx) => {
                    const carrierSpan = document.createElement("span");
                    if (idx > 0) carrierSpan.textContent = " ／ ";
                    let showStar = false, showD2 = false, showBlueStar = false, showCritical = false;

                    if (carrier === "SCD") {
                        showD2 = SCD_GROUP.some(c => checkD2Condition(c, mapping[subwave].carrierDates?.[c]));
                        showStar = SCD_GROUP.some(c => checkSLACondition(c, mapping[subwave].carrierDates?.[c]));
                        showBlueStar = SCD_GROUP.some(c => checkNDCondition(mapping[subwave].carrierDates?.[c]));
                        showCritical = SCD_GROUP.some(c => checkCriticalCondition(c, mapping[subwave].carrierDates?.[c]));
                    } else if (carrier === "UB-OMNIVA") {
                        showD2 = UB_OMNIVA_GROUP.some(c => checkD2Condition(c, mapping[subwave].carrierDates?.[c]));
                        showStar = UB_OMNIVA_GROUP.some(c => checkSLACondition(c, mapping[subwave].carrierDates?.[c]));
                        showBlueStar = UB_OMNIVA_GROUP.some(c => checkNDCondition(mapping[subwave].carrierDates?.[c]));
                        showCritical = UB_OMNIVA_GROUP.some(c => checkCriticalCondition(c, mapping[subwave].carrierDates?.[c]));
                    } else {
                        showD2 = checkD2Condition(carrier, mapping[subwave].carrierDates?.[carrier]);
                        showStar = checkSLACondition(carrier, mapping[subwave].carrierDates?.[carrier]);
                        showBlueStar = checkNDCondition(mapping[subwave].carrierDates?.[carrier]);
                        showCritical = checkCriticalCondition(carrier, mapping[subwave].carrierDates?.[carrier]);
                    }

                    if (showD2) {
                        const d = document.createElement("span");
                        d.textContent = "D2";
                        Object.assign(d.style, { color: "#fff", background: "#d32f2f", fontWeight: "bold", fontSize: "9px", borderRadius: "6px", padding: "0 5px", marginLeft: "2px", verticalAlign: "super" });
                        carrierSpan.appendChild(d);
                        carrierSpan.appendChild(document.createTextNode(" "));
                        isRowCritical = true;
                    }
                    if (showStar) {
                        const s = document.createElement("span");
                        s.textContent = "SLA";
                        Object.assign(s.style, { color: "#fff", background: "#BDA55D", fontWeight: "bold", fontSize: "9px", borderRadius: "6px", padding: "0 5px", marginLeft: "2px", verticalAlign: "super" });
                        carrierSpan.appendChild(s);
                        carrierSpan.appendChild(document.createTextNode(" "));
                    }
                    if (showBlueStar) {
                        const b = document.createElement("span");
                        b.textContent = "ND";
                        Object.assign(b.style, { color: "#fff", background: "#00008B", fontWeight: "bold", fontSize: "9px", borderRadius: "6px", padding: "0 5px", marginLeft: "2px", verticalAlign: "super" });
                        carrierSpan.appendChild(b);
                        carrierSpan.appendChild(document.createTextNode(" "));
                    }

                    const nameSpan = document.createElement("span");
                    nameSpan.textContent = carrier;
                    nameSpan.style.color = "#007";
                    nameSpan.style.fontWeight = "bold";
                    // ------------------------------------------------------------
// TOOLTIP SLA
// Po najechaniu myszką na nazwę carriera pokazuje cutoff / SLA.
// Dane pobierane są z CARRIER_CUTOFFS z początku skryptu.
// ------------------------------------------------------------
const carrierSLA = CARRIER_CUTOFFS[carrier];

if (carrierSLA) {

    nameSpan.title =
        `SLA: ${carrierSLA}`;

    nameSpan.style.cursor = "help";
}

                    let underline = false;
                    if (vipCarriers[subwave]) {
                        if (vipCarriers[subwave].has(carrier)) underline = true;
                        else if (carrier === "SCD" && SCD_GROUP.some(c => vipCarriers[subwave].has(c))) underline = true;
                        else if (carrier === "UB-OMNIVA" && UB_OMNIVA_GROUP.some(c => vipCarriers[subwave].has(c))) underline = true;
                    }

                    if (underline) {
                        nameSpan.style.textDecoration = "underline";
                        nameSpan.style.textDecorationColor = "#d32f2f";
                        nameSpan.style.fontWeight = "bold";
                    }

                   if (showCritical) {

    nameSpan.classList.add("carrier-critical");

    const criticalMessage =
        "⚠ UWAGA: Poniżej 45 minut do odjazdu!";

    // Jeśli carrier ma ustawiony cutoff,
    // pokazujemy jednocześnie SLA i ostrzeżenie.
    if (carrierSLA) {

       nameSpan.title =
    `SLA: ${carrierSLA}\n\n` +
    criticalMessage;

    } else {

        nameSpan.title = criticalMessage;
    }

    nameSpan.style.cursor = "help";

    isRowCritical = true;
}

                    carrierSpan.appendChild(nameSpan);
                    cell.appendChild(carrierSpan);
                });
            } else {
                const brak = document.createElement("span");
                brak.textContent = " No data";
                brak.style.color = "red";
                brak.style.fontWeight = "bold";
                cell.appendChild(brak);
            }

            let ordersCount = null;
            try {
                let lsOrdersRaw = localStorage.getItem('orders');
                if (lsOrdersRaw) {
                    let parsedOrders = JSON.parse(lsOrdersRaw);
                    if (typeof parsedOrders === 'object' && !Array.isArray(parsedOrders)) {
                        ordersCount = parsedOrders[subwave];
                    } else if (Array.isArray(parsedOrders)) {
                        let found = parsedOrders.find(item => Object.values(item).includes(subwave));
                        if (found) {
                            ordersCount = Object.values(found).find(val => typeof val === 'number') || found.orders || found.valOrders;
                        }
                    }
                }
            } catch (e) {}

            if (ordersCount == null && mapping[subwave] && mapping[subwave].sumE) {
                ordersCount = mapping[subwave].sumE;
            }

            if (ordersCount !== null && ordersCount !== undefined) {
                if (rowParent) {
                    let targetCell = totesColIndex !== -1 ? rowParent.children[totesColIndex] : null;
                    const ordersSpan = document.createElement("span");
                    ordersSpan.innerHTML = `📦 <b>${ordersCount} orders</b>`;

                    Object.assign(ordersSpan.style, {
                        color: "black", background: "#DFD799", fontSize: "11px",
                        borderRadius: "5px", padding: "2px 6px", marginRight: "10px", float: "right", display: "inline-block"
                    });

                    if (targetCell) targetCell.appendChild(ordersSpan);
                }
            }

            if (isRowCritical && rowParent && !rowParent.classList.contains('dx-group-row')) {
                criticalRowsToTop.push(rowParent);
            }
        }

        const rows = Array.from(document.querySelectorAll('tr')).filter(tr => tr.querySelectorAll('td').length > 0);

        for (let row of rows) {
            const tds = row.querySelectorAll('td');
            for (let cell of tds) {
                const txt = cell.textContent.trim();
                if (["Started", "Sorting", "Sorted", "All orders received", "Finished", "Deleted"].includes(txt)) {
                    cell.style.fontWeight = 'bold';
                    cell.style.color = '#fff';
                    cell.style.borderRadius = '7px';
                    cell.style.padding = '2px 6px';
                    cell.title = txt;
                    if (txt === "Started") {
                        cell.style.backgroundColor = '#ff9800';
                        cell.textContent = '🔜 ' + txt;
                    } else if (txt === "Sorting") {
                        cell.style.backgroundColor = '#03a9f4';
                        cell.textContent = '♻️ ' + txt;
                    } else if (txt === "Sorted") {
                        cell.style.backgroundColor = '#4caf50';
                        cell.textContent = '♻️' + txt;
                    } else if (txt === "All orders received") {
                        cell.style.backgroundColor = '#9c27b0';
                        cell.textContent = '💯 ' + txt;
                    } else if (txt === "Finished") {
                        cell.style.backgroundColor = '#C0C0C0';
                        cell.textContent = '✅ ' + txt;
                    } else if (txt === "Deleted") {
                        cell.style.backgroundColor = '#FF0000';
                        cell.textContent = '🚮 ' + txt;
                        cell.title = 'ForceRelease';
                    }
                }
            }
        }

        for (let row of rows) {
            const tds = row.querySelectorAll('td');
            const hasNew = [...tds].some(td => td.textContent.trim() === "New");
            for (let td of tds) {
                const txt = td.textContent.trim();
                if (/^\d{2}:\d{2}:\d{2}$/.test(txt)) {
                    const [h, m, s] = txt.split(':').map(Number);
                    const sec = h * 3600 + m * 60 + s;
                    if (sec > 1500 && sec < 10800) {
                        td.style.fontWeight = 'bold';
                        td.style.borderRadius = '7px';
                        td.title = 'Attention: time exceeded 25 minutes. Check status subwave in WMS';
                        if (hasNew) {
                            td.classList.add('blink-alert');
                            td.textContent = '⚠️ ' + txt;
                        } else {
                            td.style.backgroundColor = '#ffcccc';
                            td.textContent = '🔔 ' + txt;
                        }
                    }
                }
            }
        }

       addOsrSummaryPanel();

if (criticalRowsToTop.length > 0) {
    criticalRowsToTop.forEach(row => {
        if (!row || row.dataset.criticalStyled === 'true') return;

        row.dataset.criticalStyled = 'true';
        row.style.borderLeft = '4px solid #CC0000';
        row.style.backgroundColor = '#fff3f3';
        row.style.boxSizing = 'border-box';
    });
}

        applyCombinedFilters();

        if (upoTrendPanelOpen) {
            const trendBtn = document.getElementById('kisoft-upo-trend-btn');
            if (trendBtn) positionTrendPanelUnderButton(trendBtn);
            renderUpoTrendPanel();
        }
    }
// =========================================================
    //  OSR SUMMARY
    // =========================================================

    function addOsrSummaryPanel() {
        const toolbars = document.querySelectorAll('.dx-toolbar-items-container');
        let targetToolbar = null;
        const LEFT_MARGIN_PX = "30px";

        toolbars.forEach(tb => {
            if (tb.textContent.includes('Drag a column header here to group by that column') || tb.textContent.includes('OSR Aisle')) {
                targetToolbar = tb;
            }
        });

        if (!targetToolbar) return;

  let osrStats = {
    "OSR1_A1": {
        sumG: 0,
        sumE: 0,
        items: 0,
        focusItems: 0,
        subwaveReady: 0
    },
    "OSR1_A2": {
        sumG: 0,
        sumE: 0,
        items: 0,
        focusItems: 0,
        subwaveReady: 0
    }
};

        learnOsrAssignmentsFromVisibleRows();

       Object.keys(mapping).forEach(mult => {

    const osrAisle = osrAssignments[mult];
    if (!osrAisle || !osrStats[osrAisle] || !mapping[mult]) return;

    osrStats[osrAisle].sumG += (mapping[mult].sumG || 0);
    osrStats[osrAisle].sumE += (mapping[mult].sumE || 0);

    // wszystkie itemy
    osrStats[osrAisle].items +=
        ((mapping[mult].std || 0) +
         (mapping[mult].vip || 0));

    // focus itemy
    const statusTxt = subwaveStatus[mult] || '';

    if (
        statusTxt.includes("Started") ||
        statusTxt.includes("Sorting") ||
        statusTxt.includes("All orders received")
    ) {

        osrStats[osrAisle].focusItems +=
            ((mapping[mult].std || 0) +
             (mapping[mult].vip || 0));
    }

}); // <-- koniec forEach



        const visibleRows = Array.from(document.querySelectorAll('tr')).filter(tr => tr.querySelectorAll('td').length > 0);
        visibleRows.forEach(row => {
            const cells = Array.from(row.children);
            const subwaveCell = cells.find(td => /^MULT\d+/i.test(td.textContent.trim()));
            const statusCell = cells.find(td => {
                const t = td.textContent.trim();
                return ["Started", "Sorting", "Sorted", "All orders received"].some(s => t.includes(s));
            });

            if (!subwaveCell || !statusCell) return;

            const mult = subwaveCell.textContent.trim().match(/^MULT\d+/)?.[0];
            if (!mult) return;

            const osrAisle = osrAssignments[mult];
            if (!osrAisle || !osrStats[osrAisle]) return;
const statusTxt = statusCell.textContent.trim();

subwaveStatus[mult] = statusTxt;

GM_setValue(
    'kisoft_subwave_status',
    subwaveStatus
);

if (
    statusTxt.includes("Started") ||
    statusTxt.includes("Sorting") ||
    statusTxt.includes("Sorted") ||
    statusTxt.includes("All orders received")
) {
    osrStats[osrAisle].subwaveReady++;
}
        });

        let summaryDiv = document.getElementById('kisoft-osr-summary-toolbar');
        if (!summaryDiv) {
            summaryDiv = document.createElement('div');
            summaryDiv.id = 'kisoft-osr-summary-toolbar';

            const beforeContainer = targetToolbar.querySelector('.dx-toolbar-before');
            if (beforeContainer) {
                beforeContainer.appendChild(summaryDiv);
                beforeContainer.style.display = 'flex';
                beforeContainer.style.alignItems = 'center';
            } else {
                targetToolbar.insertBefore(summaryDiv, targetToolbar.firstChild);
            }
        }

        let html = `<div style="display:flex; gap:12px; font-family:Arial,sans-serif; margin-left:${LEFT_MARGIN_PX};">`;

        ["OSR1_A1", "OSR1_A2"].forEach(osr => {
            const stats = osrStats[osr];
            const upo = stats.sumE > 0 ? (stats.sumG / stats.sumE).toFixed(2) : "0.00";

            html += `
                <div style="background:#f7f8f7; border:1px solid #ccc; padding:4px 10px; border-radius:5px; font-size:12px; color:#333; display:flex; align-items:center; gap:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1);">
                    <span style="font-weight:bold; color:#1565c0;">${osr}</span>
            <span style="border-left:1px solid #ccc; padding-left:8px;">

${
    focusModeEnabled
        ? `Items Ready: <span style="color:#ef6c00; font-weight:700;">${stats.focusItems}</span>`
        : `Items Total: <b>${stats.items}</b>`
}
                    <span>UPO: <b style="color:#2e7d32;">${upo}</b></span>
                    <span style="border-left:1px solid #ccc; padding-left:8px;">
                        <span style="background:#DFD799; color:black; padding:2px 6px; border-radius:4px; font-size:11px; font-weight:bold;">
                            Subwave ready: ${stats.subwaveReady}
                        </span>
                    </span>
                </div>
            `;
        });

        html += `</div>`;
        summaryDiv.innerHTML = html;
    }
// =========================================================
    // AUTO-REFRESH
    // =========================================================
  class osr_overview_extended {
    expectedTabs = ['OSR\u00A0overview', 'OSR\u00A0Overview/Capacity'];
    tabName = '';
    tab;
    table;
    refreshButtonId = '';
    auto_refresh_enabled = true;
    nextRefreshTime = 0;

    refreshDelaySeconds = REFRESH_DELAY_SECONDS;
    refreshDelayStorageKey = 'osr_manual_refresh_delay_seconds';

    constructor() {
        this.loadRefreshDelay();
        this.setNextRefreshTime();
    }

    loadRefreshDelay() {
        try {
            const saved = typeof GM_getValue === 'function'
                ? GM_getValue(this.refreshDelayStorageKey, REFRESH_DELAY_SECONDS)
                : REFRESH_DELAY_SECONDS;

            const parsed = parseInt(saved, 10);

            if (!isNaN(parsed) && parsed >= 5 && parsed <= 3600) {
                this.refreshDelaySeconds = parsed;
            } else {
                this.refreshDelaySeconds = REFRESH_DELAY_SECONDS;
            }
        } catch (e) {
            console.warn('[Auto-Refresh] Cannot load saved refresh delay:', e);
            this.refreshDelaySeconds = REFRESH_DELAY_SECONDS;
        }
    }

    saveRefreshDelay(value) {
        try {
            if (typeof GM_setValue === 'function') {
                GM_setValue(this.refreshDelayStorageKey, value);
            }
        } catch (e) {
            console.warn('[Auto-Refresh] Cannot save refresh delay:', e);
        }
    }

    setNextRefreshTime() {
        this.nextRefreshTime = Date.now() + (this.refreshDelaySeconds * 1000);
    }

    clock() {
        const self = this;

        setInterval(() => {
            const now = Date.now();
            self.addReferences();
            self.checkTable();

            const switchContainer = document.querySelector('.pplx-switch');
            const timer = document.getElementById('AR_refresh_in');

            if (self.expectedTabs.indexOf(self.tabName) === -1)
             {
                self.resetInterface();
                if (switchContainer) switchContainer.classList.add('inactive');
                if (timer && timer.parentElement) timer.parentElement.style.color = 'gray';
                return;
            }

            if (switchContainer) switchContainer.classList.remove('inactive');
            if (timer && timer.parentElement) timer.parentElement.style.color = '#1565c0';

            self.addInterface();
            self.checkGrafanaStatus();
            self.attachEvents();

            const checkbox = document.getElementById('AR_checkbox');
            if (checkbox && !checkbox.dataset.clickAttached) {
                checkbox.dataset.clickAttached = 'true';
                checkbox.addEventListener('change', function () {
                    self.auto_refresh_enabled = this.checked;
                    if (self.auto_refresh_enabled) self.setNextRefreshTime();
                });
            }

            self.updateAutoRefresh(now);
        }, 1000);
    }

    resetInterface() {
    

        const settingsModal = document.getElementById('AR_settings_modal');
        if (settingsModal) settingsModal.style.display = 'none';
    }

    checkTable() {
        if (!this.expectedTabs.includes(this.tabName)) {
            this.table = undefined;
            return;
        }

        if (!this.tab) return;

        let activeTable;
        const tables = this.tab.querySelectorAll('.dx-select-checkboxes-hidden');

        tables.forEach((el) => {
            if (!el.classList.contains('dx-pointer-events-none')) {
                activeTable = el;
            }
        });

        this.table = activeTable;
    }

    addReferences() {
        let cssClass = 'tabButtonTopSelected';
        if (document.querySelectorAll('.' + cssClass).length === 0) {
            cssClass = 'tabButtonTopSelectedOver';
        }

        const selectedTabMenuItem = document.querySelector('.' + cssClass);
        const selectedTabName = selectedTabMenuItem ? selectedTabMenuItem.textContent : '';
        let selectedTabObj;

        const containers = document.querySelectorAll('.af2WebDataControlContainer');

        containers.forEach((el) => {
            const tabWrapper = el.parentElement?.parentElement;
            if (
                tabWrapper &&
                tabWrapper.style.visibility !== 'hidden' &&
                tabWrapper.style.display !== 'none' &&
                tabWrapper.offsetHeight > 0
            ) {
                selectedTabObj = tabWrapper;
            }
        });

        this.tabName = selectedTabName.trim();
        this.tab = selectedTabObj;
        this.refreshButtonId = null;
    }

    addInterface() {
        if (!document.getElementById('pplx-toggle-style')) {
            const style = document.createElement('style');
            style.id = 'pplx-toggle-style';
            style.textContent = `
                .pplx-switch { position: relative; display: inline-block; width: 40px; height: 20px; }
                .pplx-switch input { opacity: 0; width: 0; height: 0; }
                .pplx-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #d32f2f; transition: .4s; border-radius: 20px; }
                .pplx-slider:before { position: absolute; content: ""; height: 14px; width: 14px; left: 3px; bottom: 3px; background-color: white; transition: .4s; border-radius: 50%; }
                input:checked + .pplx-slider { background-color: #388e3c; }
                input:checked + .pplx-slider:before { transform: translateX(20px); }
                .pplx-switch.inactive .pplx-slider { background-color: #9e9e9e !important; cursor: not-allowed; }
                .pplx-switch.inactive input:checked + .pplx-slider { background-color: #9e9e9e !important; }

                .ar-settings-btn {
                    border: none;
                    background: transparent;
                    cursor: pointer;
                    color: #1565c0;
                    font-size: 13px;
                    line-height: 1;
                    padding: 2px 4px;
                    border-radius: 4px;
                    font-weight: bold;
                }
                .ar-settings-btn:hover {
                    background: rgba(21, 101, 192, 0.12);
                }

                .ar-settings-modal {
                    display: none;
                    position: fixed;
                    inset: 0;
                    z-index: 1000000;
                    background: rgba(0, 0, 0, 0.25);
                }

                .ar-settings-box {
                    position: absolute;
                    left: 50%;
                    top: 50%;
                    transform: translate(-50%, -50%);
                    min-width: 260px;
                    background: #fff;
                    border: 1px solid #bdbdbd;
                    border-radius: 8px;
                    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.25);
                    padding: 14px;
                    font-family: Arial, sans-serif;
                }

                .ar-settings-title {
                    font-size: 13px;
                    font-weight: bold;
                    color: #1565c0;
                    margin-bottom: 10px;
                }

                .ar-settings-row {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    margin-bottom: 12px;
                }

                .ar-settings-input {
                    width: 90px;
                    padding: 4px 6px;
                    border: 1px solid #bdbdbd;
                    border-radius: 4px;
                    font-size: 12px;
                }

                .ar-settings-actions {
                    display: flex;
                    justify-content: flex-end;
                    gap: 8px;
                }

                .ar-settings-actions button {
                    border: 1px solid #bdbdbd;
                    border-radius: 4px;
                    padding: 5px 10px;
                    cursor: pointer;
                    font-size: 12px;
                    font-weight: bold;
                }

                .ar-save-btn {
                    background: #1565c0;
                    color: #fff;
                    border-color: #1565c0 !important;
                }

                .ar-cancel-btn {
                    background: #f5f5f5;
                    color: #333;
                }

                .ar-settings-hint {
                    font-size: 11px;
                    color: #666;
                    margin-top: -6px;
                    margin-bottom: 10px;
                }
            `;
            document.head.appendChild(style);
        }

        let dialog = document.getElementById('AR_dialog');
        if (!dialog) {
            dialog = document.createElement('div');
            dialog.id = 'AR_dialog';

          Object.assign(dialog.style, {
    zIndex: 999999,
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    position: 'fixed',
    bottom: '32px',
    left: '10px',
    border: '1px solid #aaa',
    borderRadius: '4px',
    padding: '4px 10px',
    boxShadow: '0 2px 5px rgba(0,0,0,0.2)',
    fontSize: '12px',
    fontFamily: 'Arial, sans-serif',
    height: '45px',
    minWidth: '115px',
    boxSizing: 'border-box',
    textAlign: 'center',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
});

          dialog.innerHTML = `
    <div style="display:flex; flex-direction:column; justify-content:center; height:100%; gap:2px;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:2px;">
            <div style="font-weight:bold; color:#333; font-size:11px; line-height:1;">
                Auto-Refresh
            </div>
            <button id="AR_settings_btn" class="ar-settings-btn" type="button" title="Refresh settings">⚙</button>
        </div>

        <div style="display:flex; align-items:center; justify-content:flex-end; gap:4px; line-height:1;">
    <div style="font-size:14px; font-weight:bold; color:#1565c0; width:42px; text-align:center;">
        <span id="AR_refresh_in">${this.refreshDelaySeconds}</span> s
    </div>
    <label class="pplx-switch" style="margin:0;">
        <input type="checkbox" id="AR_checkbox" ${this.auto_refresh_enabled ? 'checked' : ''}>
        <span class="pplx-slider round"></span>
    </label>
</div>
    </div>
`;
            document.body.appendChild(dialog);
        } else {
            dialog.style.display = 'block';
        }

        let gDialog = document.getElementById('AR_grafana_wrapper');
        if (!gDialog) {
            gDialog = document.createElement('div');
            gDialog.id = 'AR_grafana_wrapper';

            Object.assign(gDialog.style, {
    zIndex: 999999,
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    position: 'fixed',
    bottom: '32px',
    left: '135px',
    border: '1px solid #aaa',
    borderRadius: '4px',
    padding: '4px 10px',
    boxShadow: '0 2px 5px rgba(0,0,0,0.2)',
    fontSize: '12px',
    fontFamily: 'Arial, sans-serif',
    height: '45px',
    minWidth: '115px',
    boxSizing: 'border-box',
    textAlign: 'center',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
});

            gDialog.innerHTML = `
                <div style="font-weight:bold; color:#1565c0; font-size:11px;">Grafana Sync:</div>
                <div id="AR_grafana_text" style="font-size:11px; font-weight:bold; color:#d32f2f; margin-top:5px;">--</div>
            `;
            document.body.appendChild(gDialog);
        } else {
            gDialog.style.display = 'block';
        }

        let settingsModal = document.getElementById('AR_settings_modal');
        if (!settingsModal) {
            settingsModal = document.createElement('div');
            settingsModal.id = 'AR_settings_modal';
            settingsModal.className = 'ar-settings-modal';

            settingsModal.innerHTML = `
                <div class="ar-settings-box">
                    <div class="ar-settings-title">Auto-Refresh settings</div>

                    <div class="ar-settings-row">
                        <label for="AR_refresh_delay_input" style="font-size:12px; color:#333;">Refresh every:</label>
                        <input
                            id="AR_refresh_delay_input"
                            class="ar-settings-input"
                            type="number"
                            min="5"
                            max="3600"
                            step="1"
                            value="${this.refreshDelaySeconds}"
                        />
                        <span style="font-size:12px; color:#333;">sec</span>
                    </div>

                    <div class="ar-settings-hint">Allowed range: 10 - 3600 sec</div>

                    <div class="ar-settings-actions">
                        <button id="AR_cancel_settings" class="ar-cancel-btn" type="button">Cancel</button>
                        <button id="AR_save_settings" class="ar-save-btn" type="button">Save</button>
                    </div>
                </div>
            `;
            document.body.appendChild(settingsModal);
        }

        const delayLabel = document.getElementById('AR_delay_label');
        if (delayLabel) delayLabel.textContent = String(this.refreshDelaySeconds);

        const delayInput = document.getElementById('AR_refresh_delay_input');
        if (delayInput && document.activeElement !== delayInput) {
            delayInput.value = String(this.refreshDelaySeconds);
        }
    }

    attachEvents() {
        const settingsBtn = document.getElementById('AR_settings_btn');
        const settingsModal = document.getElementById('AR_settings_modal');
        const delayInput = document.getElementById('AR_refresh_delay_input');
        const saveBtn = document.getElementById('AR_save_settings');
        const cancelBtn = document.getElementById('AR_cancel_settings');

        if (settingsBtn && !settingsBtn.dataset.bound) {
            settingsBtn.dataset.bound = 'true';
            settingsBtn.addEventListener('click', () => {
                if (delayInput) delayInput.value = String(this.refreshDelaySeconds);
                if (settingsModal) settingsModal.style.display = 'block';
            });
        }

        if (cancelBtn && !cancelBtn.dataset.bound) {
            cancelBtn.dataset.bound = 'true';
            cancelBtn.addEventListener('click', () => {
                if (settingsModal) settingsModal.style.display = 'none';
            });
        }

        if (saveBtn && !saveBtn.dataset.bound) {
            saveBtn.dataset.bound = 'true';
            saveBtn.addEventListener('click', () => {
                const rawValue = delayInput ? delayInput.value.trim() : '';
                const newValue = parseInt(rawValue, 10);

                if (isNaN(newValue) || newValue < 10 || newValue > 3600) {
                    alert('Enter value from 10 to 3600 seconds.');
                    return;
                }

                this.refreshDelaySeconds = newValue;
                this.saveRefreshDelay(newValue);
                this.setNextRefreshTime();

                const delayLabel = document.getElementById('AR_delay_label');
                if (delayLabel) delayLabel.textContent = String(newValue);

                const counter = document.getElementById('AR_refresh_in');
                if (counter) counter.textContent = String(newValue);

                if (settingsModal) settingsModal.style.display = 'none';
            });
        }

        if (settingsModal && !settingsModal.dataset.bound) {
            settingsModal.dataset.bound = 'true';
            settingsModal.addEventListener('click', (e) => {
                if (e.target === settingsModal) {
                    settingsModal.style.display = 'none';
                }
            });
        }

        if (delayInput && !delayInput.dataset.bound) {
            delayInput.dataset.bound = 'true';
            delayInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (saveBtn) saveBtn.click();
                }

                if (e.key === 'Escape') {
                    e.preventDefault();
                    if (cancelBtn) cancelBtn.click();
                }
            });
        }
    }

    checkGrafanaStatus() {
        const el = document.getElementById('AR_grafana_text');
        const box = document.getElementById('AR_grafana_wrapper');
        if (!el || !box) return;

        const rawData = GM_getValue('unified_grafana_data');

        if (!rawData || rawData.length < 5) {
            el.style.color = '#d32f2f';
            el.textContent = 'ERROR';
            box.style.borderColor = '#d32f2f';
            return;
        }

        let grafanaKeys = new Set();
        try {
            const parsed = JSON.parse(rawData);
            parsed.forEach((row) => {
                if (row.workGroup) grafanaKeys.add(row.workGroup.trim().replace(/\s+/g, ''));
            });
        } catch (e) {
            el.style.color = '#d32f2f';
            el.textContent = 'JSON ERR';
            box.style.borderColor = '#d32f2f';
            return;
        }

        const uiCells = Array.from(document.querySelectorAll('td'))
            .map((td) => td.textContent.trim())
            .filter((txt) => /^MULT\d+/.test(txt));

        if (uiCells.length === 0) {
            el.style.color = '#4caf50';
            el.textContent = 'READY';
            box.style.borderColor = '#4caf50';
            return;
        }

        let foundCount = 0;
        let missingCount = 0;
        const uniqueUiMults = [
            ...new Set(
                uiCells
                    .map((t) => t.match(/^MULT\d+/))
                    .filter(Boolean)
                    .map((match) => match[0].replace(/\s+/g, ''))
            )
        ];

        uniqueUiMults.forEach((key) => {
            if (grafanaKeys.has(key)) foundCount++;
            else missingCount++;
        });

        if (missingCount === 0) {
            el.style.color = '#4caf50';
            el.textContent = 'Data send to KiSoft';
            box.style.borderColor = '#4caf50';
        } else if (foundCount > 0) {
            el.style.color = '#ff9800';
            el.textContent = `PARTIAL (${foundCount}/${uniqueUiMults.length})`;
            box.style.borderColor = '#ff9800';
        } else {
            el.style.color = '#d32f2f';
            el.textContent = 'bad data';
            box.style.borderColor = '#d32f2f';
        }
    }

    refreshData() {
        const realKiSoftButtons = document.querySelectorAll('div[eventproxy^="isc_Af2WebReloadButton_"]');
        let clickedCount = 0;

        realKiSoftButtons.forEach((btn) => {
            if (btn && btn.offsetWidth > 0 && btn.offsetHeight > 0) {
                const style = window.getComputedStyle(btn);
                if (style.display !== 'none' && style.visibility !== 'hidden') {
                    const proxyName = btn.getAttribute('eventproxy');
                    if (proxyName) {
                        try {
                            if (typeof window[proxyName] !== 'undefined') {
                                window[proxyName].click();
                            } else {
                                eval(proxyName + '.click()');
                            }
                            clickedCount++;
                        } catch (e) {
                            const evt = new MouseEvent('click', {
                                bubbles: true,
                                cancelable: true,
                                view: window
                            });
                            btn.dispatchEvent(evt);
                            clickedCount++;
                        }
                    }
                }
            }
        });

        console.log('[Auto-Refresh] Reload buttons clicked:', clickedCount);
    }

    updateAutoRefresh(now) {
        if (!this.auto_refresh_enabled) return false;

        let remainingTime = Math.ceil((this.nextRefreshTime - now) / 1000);

        if (remainingTime <= 0) {
            this.refreshData();
            this.setNextRefreshTime();
            remainingTime = this.refreshDelaySeconds;
        }

        const el = document.getElementById('AR_refresh_in');
        if (el) el.textContent = String(remainingTime);

        const label = document.getElementById('AR_delay_label');
        if (label) label.textContent = String(this.refreshDelaySeconds);
    }
}
    loadData();
loadOsrAssignments();
// =========================================================
    // ITEM SORTER / LOCK / TOKEN
    // Uwaga: poniższy fragment końcówki był w rozmowie ucięty,
    // więc zachowuję dokładnie to, co było widoczne.
    // Nie dopisuję zmyślonego kodu, bo to byłoby złe.
    // =========================================================
function showMapModal(modalId, imageUrl) {

    const existing =
        document.getElementById(modalId);

    if (existing) {
        existing.remove();
        return;
    }

    const modal =
        document.createElement('div');

    modal.id = modalId;

    modal.style.cssText = `
        position:fixed;
        inset:0;
        background:rgba(0,0,0,.7);
        display:flex;
        align-items:center;
        justify-content:center;
        z-index:999999;
    `;

   modal.innerHTML = `
    <div id="${modalId}-window"
        style="
            position:fixed;
            left:50%;
            top:50%;
            transform:translate(-50%,-50%);
            width:1000px;
            height:750px;
            min-width:400px;
            min-height:300px;
            max-width:95vw;
            max-height:90vh;
            background:white;
            border:2px solid #555;
            border-radius:8px;
            box-shadow:0 8px 30px rgba(0,0,0,0.5);
            overflow:hidden;
            resize:both;
            display:flex;
            flex-direction:column;
        "
    >

        <div id="${modalId}-header"
            style="
                height:38px;
                background:#dfd799;
                color:black;
                display:flex;
                align-items:center;
                justify-content:space-between;
                padding:0 12px;
                cursor:move;
                user-select:none;
                font-weight:bold;
                flex-shrink:0;
            "
        >
            <span>${modalId.includes('infeed') ? '🗺️Infeed plan':'🗺️Skellet plan'}</span>

            <button id="${modalId}-close"
                style="
                    border:none;
                    background:transparent;
                    color:BLACK;
                    font-weight:bold;
                    font-size:20px;
                    cursor:pointer;
                "
            >×</button>
        </div>

        <div
            id="kisoft-image-container"
            style="
                flex:1;
                overflow:hidden;
                position:relative;
                cursor:grab;
            "
        >
            <img
                id="kisoft-map-image"
                src="${imageUrl}"
                style="
                    max-width:none;
                    display:block;
                    user-select:none;
                    -webkit-user-drag:none;
                    transform-origin:center center;
                "
            >
        </div>

    </div>
`;

    document.body.appendChild(modal);

const container = modal.querySelector('#kisoft-image-container');
const img = modal.querySelector('#kisoft-map-image');
const closeBtn = modal.querySelector(`#${modalId}-close`);

let scale = 1;
let posX = 0;
let posY = 0;

let dragging = false;
let startX = 0;
let startY = 0;

function updateTransform() {
    img.style.transform =
        `translate(${posX}px, ${posY}px) scale(${scale})`;
}

container.addEventListener('wheel', (e) => {
    e.preventDefault();

    scale *= e.deltaY < 0 ? 1.1 : 0.9;
    scale = Math.max(0.3, Math.min(scale, 8));

    updateTransform();
}, { passive: false });

container.addEventListener('mousedown', (e) => {
    dragging = true;

    startX = e.clientX - posX;
    startY = e.clientY - posY;

    container.style.cursor = 'grabbing';
});

window.addEventListener('mousemove', (e) => {
    if (!dragging) return;

    posX = e.clientX - startX;
    posY = e.clientY - startY;

    updateTransform();
});

window.addEventListener('mouseup', () => {
    dragging = false;
    container.style.cursor = 'grab';
});

closeBtn.onclick = () => {
    modal.remove();

    document
        .getElementById('kisoft-infeed-map-btn')
        ?.classList.remove('active');

    document
        .getElementById('kisoft-automation-map-btn')
        ?.classList.remove('active');
};


updateTransform();
    }

function showInfeedMapImage() {

    const btn =
        document.getElementById('kisoft-infeed-map-btn');

    const existing =
        document.getElementById('kisoft-infeed-map-modal');

    if (existing) {
        existing.remove();
        btn?.classList.remove('active');
        return;
    }

    btn?.classList.add('active');

    showMapModal(
        'kisoft-infeed-map-modal',
        'https://raw.githubusercontent.com/ReneBraille/KiSoft-Carrier-Mapper/main/infeed%202.0.png'
    );
}


function showAutomationMapImage() {

    const btn =
        document.getElementById('kisoft-automation-map-btn');

    const existing =
        document.getElementById('kisoft-automation-map-modal');

    if (existing) {
        existing.remove();
        btn?.classList.remove('active');
        return;
    }

    btn?.classList.add('active');

    showMapModal(
        'kisoft-automation-map-modal',
        'https://raw.githubusercontent.com/ReneBraille/KiSoft-Carrier-Mapper/main/automatyka%202.0.png'
    );
}



    function addInfeedMapButton() {

    if (
        document.getElementById('kisoft-infeed-map-btn') ||
        document.getElementById('kisoft-automation-map-btn')
    ) {
        return;
    }

    const upoBtn =
        document.getElementById(
            'kisoft-upo-trend-btn'
        );

    if (!upoBtn) {
        return;
    }

    const btn =
        document.createElement('button');

    btn.id = 'kisoft-infeed-map-btn';
    btn.className = 'kisoft-simple-btn kisoft-infeed-btn';
    btn.textContent = '🗺️Infeed plan';
    btn.onclick = showInfeedMapImage;

    upoBtn.insertAdjacentElement(
        'afterend',
        btn
    );

    const autoBtn =
        document.createElement('button');

    autoBtn.id =
        'kisoft-automation-map-btn';

  autoBtn.className = 'kisoft-simple-btn kisoft-automation-btn';

    autoBtn.textContent =
        '🗺️Skellet plan';

    autoBtn.onclick =
        showAutomationMapImage;

    btn.insertAdjacentElement(
        'afterend',
        autoBtn
    );
}
    function highlightItemSorterBackground() {
    try {
        const containers = document.querySelectorAll(
            '.af2WebDialog, .af2WebDataControlContainer, .dx-datagrid'
        );

        containers.forEach((container) => {
            const headerRows = Array.from(
                container.querySelectorAll('tr')
            ).filter((tr) => {
                const txt = tr.textContent.toUpperCase();

                return (
                    txt.includes('OSR_STATION_RELEASE_ON') ||
                    txt.includes('SORTER_STATION_LOCKED') ||
                    txt.includes('OSR_STATION_LOCKED') ||
                    txt.includes('LOCKED') ||
                    txt.includes('SORTER_STATION_RELEASE_ON') ||
                    txt.includes('STATION') ||
                    txt.includes('TOKEN') ||
                    txt.includes('SUBWAVE_RELEASED') ||
                    txt.includes('SUBWAVES_RELEASED')
                );
            });

            if (headerRows.length === 0) return;

            const headerRow = headerRows[0];

            const headers = Array.from(
                headerRow.querySelectorAll('td, th')
            ).map((headerCell) => {
                const titleSpan = headerCell.querySelector(
                    '.overflow-ellipsis'
                );

                return titleSpan
                    ? titleSpan.textContent.trim().toUpperCase()
                    : headerCell.textContent.trim().toUpperCase();
            });

            const colorRules = {
                OSR_STATION_LOCKED: {
                    Y: '#f44336',
                    N: '#4caf50'
                },
                SORTER_STATION_LOCKED: {
                    Y: '#f44336',
                    N: '#4caf50'
                },
                LOCKED: {
                    Y: '#f44336',
                    N: '#4caf50'
                },
                OSR_STATION_RELEASE_ON: {
                    Y: '#4caf50',
                    N: '#f44336'
                },
                SORTER_STATION_RELEASE_ON: {
                    Y: '#4caf50',
                    N: '#f44336'
                },
                TOKEN: {
                    M1: '#3366FF',
                    M2: '#3399FF'
                }
            };

            const textRules = {
                SORTER_STATION_LOCKED: {
                    Y: '🔒 Locked',
                    N: '🔓 Unlocked'
                },
                OSR_STATION_LOCKED: {
                    Y: '🔒 Locked',
                    N: '🔓 Unlocked'
                },
                LOCKED: {
                    Y: '🔒 Locked',
                    N: '🔓 Unlocked'
                },
                SORTER_STATION_RELEASE_ON: {
                    Y: '🔓 Unlocked',
                    N: '🔒 Locked'
                },
                OSR_STATION_RELEASE_ON: {
                    Y: '🔓 Unlocked',
                    N: '🔒 Locked'
                },
                TOKEN: {
                    M1: 'PTS 2',
                    M2: 'PTS 1'
                }
            };

            const dataRows = Array.from(
                container.querySelectorAll('tr.dx-data-row, tr')
            ).filter((tr) => {
                return (
                    tr !== headerRow &&
                    tr.querySelectorAll('td').length > 0
                );
            });

            dataRows.forEach((row) => {
                const cells = row.querySelectorAll('td');

                cells.forEach((td, index) => {
                    const rawText = td.textContent.trim();
                    const txt = rawText.toUpperCase();
                    const columnName = headers[index];

                    // ---------------------------------------------
                    // LOCK / RELEASE STATUS
                    // ---------------------------------------------
                    if (txt === 'Y' || txt === 'N') {
                        const hasColumnRule =
                            columnName &&
                            colorRules[columnName] &&
                            colorRules[columnName][txt];

                        if (hasColumnRule) {
                            td.style.backgroundColor =
                                colorRules[columnName][txt];
                            td.style.color = '#fff';
                            td.style.fontWeight = 'bold';
                            td.style.borderRadius = '5px';
                            td.style.textAlign = 'center';

                            const replacementText =
                                textRules[columnName]?.[txt];

                            if (replacementText) {
                                td.textContent = replacementText;
                            }
                        } else {
                            td.style.backgroundColor =
                                txt === 'Y' ? '#4caf50' : '#f44336';
                            td.style.color = '#fff';
                            td.style.fontWeight = 'bold';
                            td.style.borderRadius = '5px';
                            td.style.textAlign = 'center';
                        }

                        return;
                    }

                    // ---------------------------------------------
                    // TOKEN
                    // ---------------------------------------------
                    if (
                        columnName === 'TOKEN' &&
                        (txt === 'M1' || txt === 'M2')
                    ) {
                        td.style.backgroundColor =
                            colorRules.TOKEN[txt];
                        td.style.color = '#fff';
                        td.style.fontWeight = 'bold';
                        td.style.borderRadius = '5px';
                        td.style.textAlign = 'center';

                        const tokenText = textRules.TOKEN[txt];

                        if (tokenText) {
                            td.textContent = tokenText;
                        }

                        return;
                    }

                    // ---------------------------------------------
                    // STATION / AREA
                    // ---------------------------------------------
                    if (
                        columnName === 'STATION' &&
                        txt.startsWith('PA')
                    ) {
                        if (txt.includes('->')) return;

                        const stationNum = parseInt(
                            txt.replace('PA', ''),
                            10
                        );

                        let areaName = null;
                        let areaColor = null;

                        if (
                            stationNum >= 101 &&
                            stationNum <= 110
                        ) {
                            areaName = 'Consumables Area';
                            areaColor = '#3366FF';
                        } else if (
                            stationNum >= 111 &&
                            stationNum <= 120
                        ) {
                            areaName = 'PickTower Area';
                            areaColor = '#3366FF';
                        } else if (
                            stationNum >= 201 &&
                            stationNum <= 210
                        ) {
                            areaName = 'ShipDock Area';
                            areaColor = '#3399FF';
                        } else if (
                            stationNum >= 211 &&
                            stationNum <= 220
                        ) {
                            areaName = 'Consumables Area';
                            areaColor = '#3399FF';
                        }

                        if (areaName && areaColor) {
                            td.style.backgroundColor = areaColor;
                            td.style.color = '#fff';
                            td.style.fontWeight = 'bold';
                            td.style.borderRadius = '5px';
                            td.style.textAlign = 'center';
                            td.textContent = `${txt} -> ${areaName}`;
                        }

                        return;
                    }

                    // ---------------------------------------------
                    // SUBWAVE / ORDERS
                    // ---------------------------------------------
                    if (
                        (
                            columnName === 'SUBWAVE_RELEASED' ||
                            columnName === 'SUBWAVES_RELEASED'
                        ) &&
                        txt.startsWith('MULT')
                    ) {
                        const existing = td.querySelector(
                            '.kisoft-itemsorter-orders'
                        );

                        if (existing) {
                            existing.remove();
                        }

                        const subwaveMatch =
                            txt.match(/^MULT\d+/);

                        const subwave = subwaveMatch
                            ? subwaveMatch[0].replace(/\s+/g, '')
                            : null;

                        if (!subwave) return;

                        let ordersCount = null;

                        try {
                            const ordersRaw =
                                localStorage.getItem('orders');

                            if (ordersRaw) {
                                const parsedOrders =
                                    JSON.parse(ordersRaw);

                                if (
                                    parsedOrders &&
                                    typeof parsedOrders === 'object' &&
                                    !Array.isArray(parsedOrders)
                                ) {
                                    ordersCount =
                                        parsedOrders[subwave];
                                } else if (
                                    Array.isArray(parsedOrders)
                                ) {
                                    const foundItem =
                                        parsedOrders.find((item) => {
                                            return (
                                                item &&
                                                Object.values(item)
                                                    .includes(subwave)
                                            );
                                        });

                                    if (foundItem) {
                                        ordersCount =
                                            Object.values(foundItem)
                                                .find((value) => {
                                                    return typeof value === 'number';
                                                }) ??
                                            foundItem.orders ??
                                            foundItem.valOrders ??
                                            null;
                                    }
                                }
                            }
                        } catch (error) {
                            console.warn(
                                '[Item Sorter] Orders data error:',
                                error
                            );
                        }

                        // Safe mapping access
                        if (
                            ordersCount == null &&
                            typeof mapping !== 'undefined' &&
                            mapping?.[subwave]?.sumE != null
                        ) {
                            ordersCount =
                                mapping[subwave].sumE;
                        }

                        if (
                            ordersCount !== null &&
                            ordersCount !== undefined
                        ) {
                            const ordersSpan =
                                document.createElement('span');

                            ordersSpan.className =
                                'kisoft-itemsorter-orders';

                            ordersSpan.innerHTML =
                                ` <b>${ordersCount} orders</b>`;

                            Object.assign(ordersSpan.style, {
                                color: 'black',
                                background: '#DFD799',
                                fontWeight: 'bold',
                                fontSize: '11px',
                                borderRadius: '5px',
                                padding: '2px 6px',
                                marginLeft: '3px',
                                verticalAlign: 'middle',
                                display: 'inline-block'
                            });

                            td.appendChild(ordersSpan);
                        }
                    }
                });
            });
        });
    } catch (error) {
        console.error(
            '[Item Sorter] highlightItemSorterBackground error:',
            error
        );
    }
}

    // =========================================================
    // INICJALIZACJA / OBSERVER
    // Tego fragmentu nie było w całości w pokazanym kodzie,
    // więc nie dopisuję sztucznej końcówki.
    // Zostawiam tylko bezpieczną inicjalizację widoczną z kontekstu.
    // =========================================================

// ============================================================
// SMART MUTATION OBSERVER
//
// Observer reaguje na rzeczywiste zmiany DOM,
// ale debounce chroni przed wielokrotnym renderowaniem
// podczas jednego odświeżenia tabeli KiSoft.
// ============================================================

let observerTimeout = null;
let observerRunning = false;


const observer = new MutationObserver((mutations) => {

    // Sprawdzamy, czy zmiany faktycznie dotyczą elementów,
    // które mogą mieć znaczenie dla KiSoft.
    const hasRelevantChange = mutations.some(mutation => {

        // Interesują nas dodane lub usunięte elementy.
        if (
            mutation.type !== 'childList' ||
            (
                mutation.addedNodes.length === 0 &&
                mutation.removedNodes.length === 0
            )
        ) {
            return false;
        }

        return true;
    });


    // Ignorujemy nieistotne zmiany.
    if (!hasRelevantChange) {
        return;
    }


    // Debounce observera.
    clearTimeout(observerTimeout);

    observerTimeout = setTimeout(() => {

        // Nie uruchamiamy dwóch procesów jednocześnie.
        if (observerRunning) {
            return;
        }

        observerRunning = true;

        try {

            // ====================================================
            // OSR OVERVIEW
            // ====================================================
            if (isOsrOverview()) {

                // Funkcje same posiadają zabezpieczenia
                // przed wielokrotnym dodawaniem elementów.
                addHeader();
                addCsvInput();

                // Pełne mapowanie wykonujemy przez debounce.
                scheduleKiSoftRender(250);
            }


            // ====================================================
            // ITEM SORTER
            // ====================================================
            // Wykonujemy po zakończeniu serii zmian.
          highlightItemSorterBackground();
addInfeedMapButton();


        } catch (error) {

            console.error(
                '[KiSoft Observer] Error:',
                error
            );

        } finally {

            observerRunning = false;
        }

    }, 250);
});


// Rozpoczęcie obserwacji DOM.
observer.observe(document.body, {
    childList: true,
    subtree: true
});

if (isOsrOverview()) {
    addCsvInput();
    waitForKiSoftRows();
}

highlightItemSorterBackground();
    addInfeedMapButton();

if (!CURRENT_URL.includes('gdcgrafana-eu.logistics.corp')) {
    setTimeout(() => {
        const autoRefresher = new osr_overview_extended();
        autoRefresher.clock();
        console.log('Auto-refresher started');
    }, 2000);
}

})();