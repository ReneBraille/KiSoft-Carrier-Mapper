// ==UserScript==
// @name         KiSoft Carrier Mapper
// @namespace    http://tampermonkey.net/
// @version      1.21 (new window KiSoft Navigator)
// @description  Dodatkowa informacja o subwave w KiSoft Navigator
// @author       vasyl.hospodyn@cevalogistics.com
// @match        https://gdcgrafana-eu.logistics.corp/d/dOHkIABY83AGEIHMDTLOPSPRODSTD/ageing-heatmap-detail-prod?orgId=1*
// @match        https://10.218.15.10:4444/af/*
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function () {
    'use strict';

    // --- KONFIGURACJA ---
    const CURRENT_URL = window.location.href;
    const AUTO_SYNC_MS = 1200000; // 20 minut
    const BLINK_SPEED_SECONDS = 2.2; // Szybkość mrugania alertów
    const REFRESH_DELAY_SECONDS = 15; // Czas auto-odświeżania

    // --- GODZINY WYJAZDÓW (CUT-OFF) ---
    const CARRIER_CUTOFFS = {
        "DHLPAK-EX": "07:30",
        "HERMESDE-EX": "10:00",
        "ZAS-EX": "11:00",
        "PPL-EX": "13:30",
        "UB-INPOST": "14:30",
        "UB-OMNIVA": "15:30", // <--- WAŻNE: Grupa Omniva
        "SCD": "23:00",       // <--- WAŻNE: Grupa SCD
    };

    // =============================================================================
    // CZĘŚĆ 1: GRAFANA COLLECTOR
    // =============================================================================
    const isGrafanaDomain = CURRENT_URL.includes('gdcgrafana-eu.logistics.corp');
    const isTargetView = CURRENT_URL.includes('#TEST');

    if (isGrafanaDomain && isTargetView) {
        console.log('[Grafana] Collector Active');

        const StatusUI = {
            element: null,
            create() {
                const div = document.createElement('div');
                div.style.cssText = `position:fixed;bottom:10px;right:10px;background:#1e1e1e;color:#eee;padding:12px;border-radius:6px;border:1px solid #555;box-shadow:0 4px 12px rgba(0,0,0,0.5);font-family:monospace;font-size:11px;z-index:99999;min-width:220px;`;
                div.innerHTML = `
                    <div style="font-weight:bold;color:#64b5f6;margin-bottom:6px;">Grafana Sync</div>
                    <div>Status: <span id="gc-status" style="color:#ffb74d">Scanning...</span></div>
                    <div>Rekordów: <span id="gc-count" style="font-weight:bold">0</span></div>
                `;
                document.body.appendChild(div);
                this.element = div;
            },
            update(status, count, isSuccess) {
                if (!this.element) this.create();
                const s = document.getElementById('gc-status');
                const c = document.getElementById('gc-count');
                s.textContent = status;
                s.style.color = isSuccess ? '#81c784' : '#ffb74d';
                c.textContent = count;
                this.element.style.borderColor = isSuccess ? '#2e7d32' : '#555';
            }
        };

        const DataCollector = {
            collectData() {
                let rows = Array.from(document.querySelectorAll('table tr'));
                if (rows.length < 2) rows = Array.from(document.querySelectorAll('div[role="row"]'));

                let collectedRows = [];
                let count = 0;

                rows.forEach(row => {
                    let cells = row.querySelectorAll('td');
                    if (cells.length === 0) cells = Array.from(row.children);
                    const rowData = Array.from(cells).map(c => c.textContent.trim());

                    if (rowData.length > 7 && rowData[0].startsWith('MULT')) {
                        collectedRows.push({
                            workGroup: rowData[0],       // Col 0
                            orderType: rowData[1] || '', // Col 1
                            carrierId: rowData[2] || '', // Col 2
                            shipByDate: rowData[3] || '',// Col 3

                            // === ROZDZIELENIE DANYCH ===
                            valOrders: parseInt(rowData[5] || '0'), // Col 5 (Orders) - TYLKO DO UPO
                            valLines: parseInt(rowData[6] || '0'),  // Col 6 (Lines) - ILOŚĆ DLA STD/VIP
                            valTasked: parseInt(rowData[7] || '0'), // Col 7 (Tasked) - DO UPO

                            shipmentGroup: rowData[9] || ''
                        });
                        count++;
                    }
                });

                if (count > 0) {
                    GM_setValue('unified_grafana_data', JSON.stringify(collectedRows));
                    StatusUI.update('SEND TO KISOFT', count, true);
                } else {
                    StatusUI.update('Search Data...', 0, false);
                }
            }
        };

        setTimeout(() => StatusUI.create(), 1500);
        setInterval(DataCollector.collectData, 3000);
        return;
    } else if (isGrafanaDomain) {
        console.log('[Grafana] Skrypt wstrzymany - niewłaściwy widok (brak #TEST).');
        return;
    }

    // =============================================================================
    // CZĘŚĆ 2: KISOFT LOGIC
    // =============================================================================

    console.log('[KiSoft] Mapper v3.25 Loaded');

    let mapping = {};
    let vipCarriers = {};
    let autoSyncInterval = null;
    let autoSyncCountdownInterval = null;

    function syncFromGrafana(statusEl, isAuto = false) {
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

        try {
            let gData = JSON.parse(raw);
            if (!Array.isArray(gData)) gData = Object.values(gData);

            mapping = {};
            vipCarriers = {};

            gData.forEach(rec => {
                const subwave = (rec.workGroup || '').replace(/\s+/g, '');
                let type = (rec.orderType || '').toUpperCase().replace(/^B2C-/, '').trim();
                const carrier = rec.carrierId;
                const carrierDate = rec.shipByDate;
                const osr = rec.shipmentGroup;

                const qtyLines = parseInt(rec.valLines) || 0;
                const qtyOrders = parseInt(rec.valOrders) || 0;
                const qtyTasked = parseInt(rec.valTasked) || 0;

                // --- INICJALIZACJA STRUKTURY DANYCH ---
                if (!mapping[subwave]) {
                    mapping[subwave] = {
                        carriers: [],
                        std: 0,
                        vip: 0,
                        vipBreakdown: {}, // Dla VIP
                        stdBreakdown: {}, // Dla STD
                        sumG: 0,
                        sumE: 0,
                        carrierDates: {},
                        osrs: []
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
                        // --- ZBIERANIE DANYCH STD ---
                        if (carrier) {
                            if (!mapping[subwave].stdBreakdown[carrier]) mapping[subwave].stdBreakdown[carrier] = 0;
                            mapping[subwave].stdBreakdown[carrier] += qtyLines;
                        }
                    } else if (type.includes('VIP')) {
                        mapping[subwave].vip += qtyLines;
                        if (carrier) {
                            vipCarriers[subwave].add(carrier);
                            // --- ZBIERANIE DANYCH VIP ---
                            if (!mapping[subwave].vipBreakdown[carrier]) mapping[subwave].vipBreakdown[carrier] = 0;
                            mapping[subwave].vipBreakdown[carrier] += qtyLines;
                        }
                    } else {
                        mapping[subwave].std += qtyLines; // Default to STD
                    }
                }

                if (!isNaN(qtyTasked)) mapping[subwave].sumG += qtyTasked;
                if (!isNaN(qtyOrders)) mapping[subwave].sumE += qtyOrders;
            });

            saveData();

            if (statusEl) {
                statusEl.textContent = `Auto-Sync: 20:00`;
                statusEl.style.color = '#1565c0';
            }

            mapToKiSoft();
        } catch (e) {
            console.error(e);
            if (statusEl) {
                statusEl.textContent = 'Error Data';
                statusEl.style.color = 'red';
            }
        }
    }

    function addHeader() {
        if (!isOsrOverview()) return;
        const filterPanel = document.getElementById('isc_17')
        if (!filterPanel || filterPanel.querySelector('#kisoftexcel-header')) return;

        const header = document.createElement('div');
        header.id = 'kisoftexcel-header';
        header.style.cssText = `float: right; margin-right: 20px;margin-top: 1px; font-family: Arial, sans-serif; color: black; white-space: nowrap; display: inline-block; vertical-align: middle; text-align: right;`;
        header.innerHTML = `<div style="font-size: 13px; font-weight: bold; margin-bottom: 2px;">KiSoft Carrier Mapper v1.21</div>
                            <div style="font-size: 12px; font-family: monospace; color: black;">vasyl.hospodyn@cevalogistics.com</div>`;

        filterPanel.appendChild(header);
    }

    function isOsrOverview() {
        const activeTabTitle = document.querySelector('.tabButtonTopSelected .af2WebDialogTabTitle');
        if (!activeTabTitle) return false;
        const txt = activeTabTitle.textContent.replace(/\u00a0/g, ' ').trim();
        return txt === 'OSR overview' || txt === 'OSR overview 2' || txt === 'OSR Overview/Capacity';
    }

    function saveData() {
        localStorage.setItem('kisoftexcel_mapping', JSON.stringify(mapping));
        let vipToSave = {};
        for(let k in vipCarriers) vipToSave[k] = Array.from(vipCarriers[k]);
        localStorage.setItem('kisoftexcel_vipcarriers', JSON.stringify(vipToSave));
    }

    function loadData() {
        try { mapping = JSON.parse(localStorage.getItem('kisoftexcel_mapping') || '{}'); } catch(e) { mapping = {}; }
        try {
            const vipData = JSON.parse(localStorage.getItem('kisoftexcel_vipcarriers') || '{}');
            vipCarriers = {};
            for (let key in vipData) vipCarriers[key] = new Set(vipData[key]);
        } catch(e) { vipCarriers = {}; }
    }

    function addCsvInput() {
        if (!isOsrOverview()) return;
        const filterPanel = document.getElementById('isc_17');
        if (!filterPanel) return;

        if (!document.getElementById('kisoft-custom-buttons-style')) {
            const s = document.createElement('style');
            s.id = 'kisoft-custom-buttons-style';
            s.innerHTML = `
                /* --- STYLE PRZYCISKU CLEAR --- */
                .kisoft-del-btn {
                  position: relative;
                  border-radius: 6px;
                  width: 120px;
                  height: 34px;
                  cursor: pointer;
                  display: inline-flex;
                  align-items: center;
                  border: 1px solid #cc0000;
                  background-color: #e50000;
                  overflow: hidden;
                  margin-left: 275px;
                  vertical-align: middle;
                  margin-top: 3px;
                }
                .kisoft-del-btn, .kisoft-del-btn__icon, .kisoft-del-btn__text { transition: all 0.3s; }

                .kisoft-del-btn .kisoft-del-btn__text {
                  transform: translateX(10px);
                  color: #fff;
                  font-weight: 600;
                  font-family: Arial, sans-serif;
                  font-size: 13px;
                }

                .kisoft-del-btn .kisoft-del-btn__icon {
                  position: absolute; transform: translateX(85px); height: 100%; width: 34px;
                  background-color: #cc0000; display: flex; align-items: center; justify-content: center;
                }
                .kisoft-del-btn .svg { width: 18px; }
                .kisoft-del-btn:hover { background: #cc0000; }
                .kisoft-del-btn:hover .kisoft-del-btn__text { color: transparent; }
                .kisoft-del-btn:hover .kisoft-del-btn__icon { width: 118px; transform: translateX(0); }
                .kisoft-del-btn:active .kisoft-del-btn__icon { background-color: #b20000; }
                .kisoft-del-btn:active { border: 1px solid #b20000; }

                @keyframes btn-press { 0% { transform: scale(1); } 40% { transform: scale(0.92); filter: brightness(0.9); } 100% { transform: scale(1); filter: brightness(1); } }
                .btn-anim-click { animation: btn-press 0.2s ease-out forwards; }

                /* --- STYLE PRZYCISKU SYNC GRAFANA --- */
                .kisoft-sync-btn {
                  --primary: #1565c0;
                  --neutral-1: #f7f8f7;
                  --neutral-2: #e7e7e7;
                  --radius: 6px;

                  cursor: pointer;
                  border-radius: var(--radius);
                  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.3);
                  border: 1px solid #ccc;
                  box-shadow: 0 0.5px 0.5px 1px rgba(255, 255, 255, 0.2),
                    0 2px 4px rgba(0, 0, 0, 0.1);
                  display: inline-flex;
                  align-items: center;
                  justify-content: center;
                  position: relative;
                  transition: all 0.3s ease;

                  min-width: 140px;
                  padding: 0 10px;
                  height: 34px;
                  margin-left: 10px;
                  vertical-align: middle;
                  margin-top: 3px;

                  font-family: Arial, sans-serif;
                  font-style: normal;
                  font-size: 13px;
                  font-weight: 600;
                  color: #1565c0;
                  background: white;
                }

                .kisoft-sync-btn:hover {
                  transform: scale(1.02);
                  box-shadow: 0 0 1px 2px rgba(255, 255, 255, 0.3),
                    0 4px 8px rgba(0, 0, 0, 0.2);
                }
                .kisoft-sync-btn:active, .kisoft-sync-btn:focus {
                  transform: scale(1);
                  outline: none;
                }

                .kisoft-sync-btn:after {
                  content: "";
                  position: absolute;
                  inset: 0;
                  border-radius: var(--radius);
                  border: 1px solid transparent;
                  background: linear-gradient(var(--neutral-1), var(--neutral-2)) padding-box,
                    linear-gradient(to bottom, rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.45)) border-box;
                  z-index: 0;
                  transition: all 0.4s ease;
                }
                .kisoft-sync-btn:hover::after {
                  transform: scale(1.02, 1.05);
                }

                .kisoft-sync-btn::before {
                  content: "";
                  inset: 2px;
                  position: absolute;
                  background: linear-gradient(to top, var(--neutral-1), var(--neutral-2));
                  border-radius: 4px;
                  filter: blur(0.5px);
                  z-index: 2;
                }

                .kisoft-state p {
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  margin: 0;
                }

                .kisoft-state .icon {
                  position: absolute;
                  left: 0;
                  top: 0;
                  bottom: 0;
                  margin: auto;
                  transform: scale(0.9);
                  transition: all 0.3s ease;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  color: #1565c0;
                }
                .kisoft-state .icon svg { overflow: visible; width: 1.2em; height: 1.2em; }

                /* Outline */
                .kisoft-outline {
                  position: absolute;
                  border-radius: inherit;
                  overflow: hidden;
                  z-index: 1;
                  opacity: 0;
                  transition: opacity 0.4s ease;
                  inset: -1px;
                }
                .kisoft-outline::before {
                  content: "";
                  position: absolute;
                  inset: -100%;
                  background: conic-gradient(from 180deg, transparent 60%, white 80%, transparent 100%);
                  animation: spin 2s linear infinite;
                  animation-play-state: paused;
                }
                @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                .kisoft-sync-btn:hover .kisoft-outline { opacity: 1; }
                .kisoft-sync-btn:hover .kisoft-outline::before { animation-play-state: running; }

                /* Letters Animation */
                .kisoft-state p span {
                  display: block;
                  opacity: 0;
                  animation: slideDown 0.8s ease forwards calc(var(--i) * 0.03s);
                  color: #1565c0;
                }
                .kisoft-sync-btn:hover p span {
                  opacity: 1;
                  animation: wave 0.5s ease forwards calc(var(--i) * 0.02s);
                }
                .kisoft-sync-btn:focus p span {
                  opacity: 1;
                  animation: disapear 0.6s ease forwards calc(var(--i) * 0.03s);
                }

                @keyframes wave {
                  30% { opacity: 1; transform: translateY(2px) translateX(0) rotate(0); }
                  50% { opacity: 1; transform: translateY(-1px) translateX(0) rotate(0); color: var(--primary); }
                  100% { opacity: 1; transform: translateY(0) translateX(0) rotate(0); }
                }
                @keyframes slideDown {
                  0% { opacity: 0; transform: translateY(-10px) translateX(2px) rotate(-90deg); color: var(--primary); filter: blur(2px); }
                  30% { opacity: 1; transform: translateY(2px) translateX(0) rotate(0); filter: blur(0); }
                  50% { opacity: 1; transform: translateY(-1px) translateX(0) rotate(0); }
                  100% { opacity: 1; transform: translateY(0) translateX(0) rotate(0); }
                }
                @keyframes disapear {
                  from { opacity: 1; }
                  to { opacity: 0; transform: translateX(2px) translateY(10px); color: var(--primary); filter: blur(2px); }
                }

                /* SYNC ANIMATIONS */
                .state--default .icon svg { animation: land 0.6s ease forwards; }
                .kisoft-sync-btn:hover .state--default .icon { transform: rotate(180deg) scale(1); }
                .kisoft-sync-btn:focus .state--default svg { animation: spinAway 0.8s linear forwards; }
                .kisoft-sync-btn:focus .state--default .icon { transform: rotate(0) scale(1); }

                @keyframes spinAway {
                  0% { opacity: 1; transform: rotate(0deg); }
                  60% { opacity: 1; transform: rotate(360deg) scale(0.5); }
                  100% { opacity: 0; transform: rotate(720deg) scale(0); }
                }
                @keyframes land {
                  0% { transform: scale(0); opacity: 0; filter: blur(2px); }
                  100% { transform: scale(1); opacity: 1; filter: blur(0); }
                }

                .state--default .icon:before { display: none; }
                .kisoft-state { padding-left: 20px; z-index: 2; display: flex; position: relative; }
                .state--default span:nth-child(4) { margin-right: 5px; }
                .state--sent { display: none; }
                .state--sent svg { transform: scale(1); margin-right: 5px; }
                .kisoft-sync-btn:focus .state--default { position: absolute; }
                .kisoft-sync-btn:focus .state--sent { display: flex; }
                .kisoft-sync-btn:focus .state--sent span { opacity: 0; animation: slideDown 0.8s ease forwards calc(var(--i) * 0.2s); }
                .kisoft-sync-btn:focus .state--sent .icon svg { opacity: 0; animation: appear 1.2s ease forwards 0.8s; }
                @keyframes appear {
                  0% { opacity: 0; transform: scale(2) rotate(-40deg); color: var(--primary); filter: blur(2px); }
                  30% { opacity: 1; transform: scale(0.6); filter: blur(1px); }
                  50% { opacity: 1; transform: scale(1.1); filter: blur(0); }
                  100% { opacity: 1; transform: scale(1); }
                }

                /* --- STYLE POLA INSERT DATA WMS --- */
                .kisoft-paste-input {
                    --primary: #1565c0;
                    --radius: 6px;

                    height: 34px;
                    width: 150px;
                    min-width: 140px;
                    max-width: 150px;

                    padding-left: 12px;
                    padding-right: 10px;
                    padding-top: 8px;
                    margin-left: 10px;
                    box-sizing: border-box;
                    vertical-align: middle;
                    display: inline-block;
                    margin-top: 3px;

                    border: 1px solid #ccc;
                    border-radius: var(--radius);
                    background: white;
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);

                    color: var(--primary);
                    font-family: Arial, sans-serif;
                    font-size: 13px;
                    font-weight: 600;
                    text-align: left;
                    line-height: normal;

                    resize: none;
                    overflow: hidden;
                    white-space: nowrap;
                    transition: all 0.3s ease;
                }

                .kisoft-paste-input:hover {
                    transform: scale(1.02);
                    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
                }

                .kisoft-paste-input:focus {
                    border-color: var(--primary);
                    outline: none;
                    transform: scale(1);
                    box-shadow: 0 0 0 2px rgba(21, 101, 192, 0.1);
                }

                .kisoft-paste-input::placeholder {
                    color: #90caf9;
                    font-weight: normal;
                }

                /* --- BLINKING ALERT ANIMATION --- */
                @keyframes blink-red {
                    0% { background-color: #ff0000; }
                    50% { background-color: #ff8888; }
                    100% { background-color: #ff0000; }
                }
                .blink-alert {
                    animation: blink-red ${BLINK_SPEED_SECONDS}s infinite;
                    color: white !important;
                    font-weight: bold;
                    border-radius: 7px;
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
                  <path d="M112,112l20,320c.95,18.49,14.4,32,32,32H348c17.67,0,30.87-13.51,32-32l20-320" style="fill:none;stroke:#fff;stroke-linecap:round;stroke-linejoin:round;stroke-width:32px"></path>
                  <line style="stroke:#fff;stroke-linecap:round;stroke-miterlimit:10;stroke-width:32px" x1="80" x2="432" y1="112" y2="112"></line>
                  <path d="M192,112V72h0a23.93,23.93,0,0,1,24-24h80a23.93,23.93,0,0,1,24,24h0v40" style="fill:none;stroke:#fff;stroke-linecap:round;stroke-linejoin:round;stroke-width:32px"></path>
                  <line style="fill:none;stroke:#fff;stroke-linecap:round;stroke-linejoin:round;stroke-width:32px" x1="256" x2="256" y1="176" y2="400"></line>
                  <line style="fill:none;stroke:#fff;stroke-linecap:round;stroke-linejoin:round;stroke-width:32px" x1="184" x2="192" y1="176" y2="400"></line>
                  <line style="fill:none;stroke:#fff;stroke-linecap:round;stroke-linejoin:round;stroke-width:32px" x1="328" x2="320" y1="176" y2="400"></line>
                </svg>
              </span>
            `;

            clearBtn.onclick = () => {
                triggerAnimation(clearBtn);
                mapping = {}; vipCarriers = {};
                localStorage.removeItem('kisoftexcel_mapping'); localStorage.removeItem('kisoftexcel_vipcarriers');
                mapToKiSoft();
                const pasteArea = document.getElementById('kisoftexcelpaste'); if (pasteArea) pasteArea.value = '';
            };

            filterPanel.appendChild(clearBtn);
        }

        if (!filterPanel.querySelector('#kisoftexcelpaste')) {
            const pasteArea = document.createElement('textarea');
            pasteArea.placeholder = 'Insert WMS Data';
            pasteArea.id = 'kisoftexcelpaste';
            pasteArea.className = 'kisoft-paste-input';

            pasteArea.addEventListener('paste', e => {
                e.preventDefault(); const text = e.clipboardData.getData('text'); if (!text.trim()) return;
                parseCsvText(text); mapToKiSoft(); saveData();
                pasteArea.style.borderColor = '#4caf50'; setTimeout(() => { pasteArea.style.borderColor = '#ccc'; }, 1300);
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
                  <span style="--i:0">S</span>
                  <span style="--i:1">y</span>
                  <span style="--i:2">n</span>
                  <span style="--i:3">c</span>
                  <span style="--i:4">&nbsp;</span>
                  <span style="--i:5">G</span>
                  <span style="--i:6">r</span>
                  <span style="--i:7">a</span>
                  <span style="--i:8">f</span>
                  <span style="--i:9">a</span>
                  <span style="--i:10">n</span>
                  <span style="--i:11">a</span>
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
                  <span style="--i:5">S</span>
                  <span style="--i:6">y</span>
                  <span style="--i:7">n</span>
                  <span style="--i:8">c</span>
                </p>
              </div>
            `;

            const statusSpan = document.createElement('span');
            statusSpan.id = 'grafana-sync-status';
            statusSpan.style.cssText = 'margin-left: 8px; font-weight: bold; color:#1565c0; font-size: 11px; display: inline-block; vertical-align: middle;margin-top: 3px;';
            statusSpan.textContent = 'Auto-Sync: 20:00';

            syncBtn.onclick = (e) => {
                e.preventDefault();
                syncBtn.focus();
                syncBtn.style.pointerEvents = 'none';
                syncFromGrafana(statusSpan);
                setTimeout(() => {
                    syncBtn.blur();
                    syncBtn.style.pointerEvents = 'auto';
                }, 2000);
            };

            filterPanel.appendChild(syncBtn);
            filterPanel.appendChild(statusSpan);

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
                    if (mm === 0 && ss === 0) { el.textContent = `Auto-Sync: 00:00`; return; }
                    let total = mm * 60 + ss - 1; if (total < 0) total = 0;
                    const newMM = String(Math.floor(total / 60)).padStart(2, '0');
                    const newSS = String(total % 60).padStart(2, '0');
                    el.textContent = `Auto-Sync: ${newMM}:${newSS}`;
                }, 1000);
            }
        }
    }

    function parseCsvText(text) {
        mapping = {}; vipCarriers = {};
        const lines = text.split('\n');
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const cols = line.split(/\t|,/);
            if (cols.length < 10) continue;
            const subwave = cols[0].trim().replace(/\s+/g, '');
            let type = cols[1].trim().replace(/^B2C-/, '').trim().toUpperCase();
            const carrier = cols[2].trim();
            const carrierDate = cols[3]?.trim() || null;
            const itemsE = parseInt(cols[5]?.trim(), 10) || 0;
            const items = parseInt(cols[6]?.trim(), 10) || 0;
            const itemsG = parseInt(cols[7]?.trim(), 10) || 0;
            const osr = cols[9]?.trim() || null;

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
    }

       function mapToKiSoft() {
        if (!isOsrOverview()) return;


                // --- STYLE DLA PULSUJĄCEGO CARRIERA ---
        if (!document.getElementById('kisoft-critical-style')) {
            const s = document.createElement('style');
            s.id = 'kisoft-critical-style';
            s.innerHTML = `
                @keyframes text-pulse-critical {
                    35%, 100% { opacity: 1; }
                    60% { opacity: 0.3; }
                }
                .carrier-critical {
                    animation: text-pulse-critical 2.8s infinite ease-in-out !important;
                    display: inline-block;
                    color: #CC0000 !important;
                    font-weight: 900 !important;
                    cursor: help;
                }
            `;
            document.head.appendChild(s);
        }

        // --- ZNALEZIENIE INDEXU KOLUMNY 'Totes in group' ---
        let totesColIndex = -1;
        document.querySelectorAll('td, th').forEach(el => {
            if (el.textContent.trim() === 'Totes in group') {
                const tr = el.closest('tr');
                if (tr) totesColIndex = Array.from(tr.children).indexOf(el);
            }
        });

        const cells = Array.from(document.querySelectorAll('td')).filter(td => /^MULT\d+$/i.test(td.textContent.trim()));

        const scdGroup = [
            "HERMESINT-EX", "ACS-CY", "ACS-GR", "BPOST-EX", "COLISSIMO-EX", "CROATIANPOST-EX",
            "DHLPAK-RET-EX", "ECONT", "GLSHU-MAGYAR-EX", "MAGYAR-POSTA", "POSTA-SI",
            "POSTE-IT", "POSTNL-EX", "SK-POSTA-EX", "SWISSPOST-EX", "UB-CORREOS", "UB-CTT",
            "UB-DHLSE", "UB-FASTWAY", "UB-GLSDK", "UB-POSTI", "UB-POSTNORD", "UB-SEUR-ES", "UPS-EX", "ZAS-EX-SK" ,"FAN-V2-EX"
        ];
        const ubOmnivaGroup = ["UB-OMNIVA-LT", "UB-OMNIVA-LV", "UB-OMNIVA-EE"];

                const now = new Date();
        const currMins = now.getHours() * 60 + now.getMinutes();
        const midnightToday = new Date();
        midnightToday.setHours(0,0,0,0);

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

                // BLOKADA: Jeżeli data wysyłki to JUTRO lub PÓŹNIEJ (czyli ND),

                if (dt.getTime() > midnightToday.getTime()) return false;

                // Dla D2 (przeszłość) i SLA (dzisiaj) sprawdzamy czas do odjazdu
                let [h, m] = CARRIER_CUTOFFS[c].split(':').map(Number);
                let cutoffMins = h * 60 + m;
                let diff = cutoffMins - currMins;

                return diff >= 0 && diff <= 45;
            });
        };
        for (let cell of cells) {
            const rawSubwave = cell.textContent.trim().match(/^MULT\d+/)?.[0];
            if (!rawSubwave) continue;
            const subwave = rawSubwave.replace(/\s+/g, '');

            cell.innerHTML = '';
            const multCopyBtn = document.createElement('span');
            multCopyBtn.textContent = rawSubwave;
            Object.assign(multCopyBtn.style, {
                cursor: 'pointer',
                color: 'black',
                padding: '2px 4px',
                borderRadius: '4px',
                transition: 'all 0.2s',
                display: 'inline-block'
            });
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
                    sep.style.color = 'black'; sep.style.fontWeight = 'bold';
                    cell.appendChild(sep);

                    const std = document.createElement('span'); std.textContent = 'STD';
                    Object.assign(std.style, {color: "#fff", background: "#1976d2", fontWeight: 'bold', fontSize: '11px', borderRadius: '7px', padding: '2px 6px', lineHeight: '1.5', verticalAlign: 'middle'});
                    if (mapping[subwave].stdBreakdown) {
                        let tooltipText = [];
                        for (const [c, count] of Object.entries(mapping[subwave].stdBreakdown)) tooltipText.push(`${c}: ${count}`);
                        if (tooltipText.length > 0) { std.title = tooltipText.join('\n'); std.style.cursor = 'help'; }
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
                    sep.style.color = 'black'; sep.style.fontWeight = 'bold';
                    cell.appendChild(sep);

                    const vip = document.createElement('span'); vip.textContent = 'VIP';
                    Object.assign(vip.style, {color: "#fff", background: "#d32f2f", fontWeight: 'bold', fontSize: '11px', borderRadius: '7px', padding: '2px 6px', lineHeight: '1.5', verticalAlign: 'middle'});
                    if (mapping[subwave].vipBreakdown) {
                        let tooltipText = [];
                        for (const [c, count] of Object.entries(mapping[subwave].vipBreakdown)) tooltipText.push(`${c}: ${count}`);
                        if (tooltipText.length > 0) { vip.title = tooltipText.join('\n'); vip.style.cursor = 'help'; }
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

                const arrow = document.createElement('span'); arrow.textContent = '➭ '; arrow.style.color = '#007'; arrow.style.fontWeight = 'bold';
                cell.appendChild(arrow);
            }

            if (mapping[subwave]?.carriers?.length) {
                const hasSCD = mapping[subwave].carriers.some(carrier => scdGroup.includes(carrier));
                const hasUBOMNIVA = mapping[subwave].carriers.some(carrier => ubOmnivaGroup.includes(carrier));
                const otherCarriersSet = new Set();
                mapping[subwave].carriers.forEach(carrier => {
                    if (!scdGroup.includes(carrier) && !ubOmnivaGroup.includes(carrier)) otherCarriersSet.add(carrier);
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
                        showD2 = scdGroup.some(c => checkD2Condition("SCD", mapping[subwave].carrierDates?.[c]));
                        showStar = scdGroup.some(c => checkSLACondition("SCD", mapping[subwave].carrierDates?.[c]));
                        showBlueStar = scdGroup.some(c => checkNDCondition(mapping[subwave].carrierDates?.[c]));
                        showCritical = scdGroup.some(c => checkCriticalCondition("SCD", mapping[subwave].carrierDates?.[c]));
                    } else if (carrier === "UB-OMNIVA") {
                        showD2 = ubOmnivaGroup.some(c => checkD2Condition("UB-OMNIVA", mapping[subwave].carrierDates?.[c]));
                        showStar = ubOmnivaGroup.some(c => checkSLACondition("UB-OMNIVA", mapping[subwave].carrierDates?.[c]));
                        showBlueStar = ubOmnivaGroup.some(c => checkNDCondition(mapping[subwave].carrierDates?.[c]));
                        showCritical = ubOmnivaGroup.some(c => checkCriticalCondition("UB-OMNIVA", mapping[subwave].carrierDates?.[c]));
                    } else {
                        showD2 = checkD2Condition(carrier, mapping[subwave].carrierDates?.[carrier]);
                        showStar = checkSLACondition(carrier, mapping[subwave].carrierDates?.[carrier]);
                        showBlueStar = checkNDCondition(mapping[subwave].carrierDates?.[carrier]);
                        showCritical = checkCriticalCondition(carrier, mapping[subwave].carrierDates?.[carrier]);
                    }

                    if (showD2) {
                        const d = document.createElement("span"); d.textContent = "D2";
                        Object.assign(d.style, {color: "#fff", background: "#d32f2f", fontWeight: "bold", fontSize: "9px", borderRadius: "6px", padding: "0 5px", marginLeft: "2px", verticalAlign: "super"});
                        carrierSpan.appendChild(d); carrierSpan.appendChild(document.createTextNode(" "));
                    }
                    if (showStar) {
                        const s = document.createElement("span"); s.textContent = "SLA";
                        Object.assign(s.style, {color: "#fff", background: "#BDA55D", fontWeight: "bold", fontSize: "9px", borderRadius: "6px", padding: "0 5px", marginLeft: "2px", verticalAlign: "super"});
                        carrierSpan.appendChild(s); carrierSpan.appendChild(document.createTextNode(" "));
                    }
                    if (showBlueStar) {
                        const b = document.createElement("span"); b.textContent = "ND";
                        Object.assign(b.style, {color: "#fff", background: "#00008B", fontWeight: "bold", fontSize: "9px", borderRadius: "6px", padding: "0 5px", marginLeft: "2px", verticalAlign: "super"});
                        carrierSpan.appendChild(b); carrierSpan.appendChild(document.createTextNode(" "));
                    }

                    const nameSpan = document.createElement("span");
                    nameSpan.textContent = carrier;
                    nameSpan.style.color = "#007";
                    nameSpan.style.fontWeight = "bold";

                    let underline = false;
                    if (vipCarriers[subwave]) {
                        if (vipCarriers[subwave].has(carrier)) underline = true;
                        else if (carrier === "SCD" && scdGroup.some(c => vipCarriers[subwave].has(c))) underline = true;
                        else if (carrier === "UB-OMNIVA" && ubOmnivaGroup.some(c => vipCarriers[subwave].has(c))) underline = true;
                    }

                    if (underline) {
                        nameSpan.style.textDecoration = "underline";
                        nameSpan.style.textDecorationColor = "#d32f2f";
                        nameSpan.style.fontWeight = "bold";
                    }

                    if (showCritical) {
                        nameSpan.classList.add("carrier-critical");
                        nameSpan.title = "UWAGA: Poniżej 45 minut do odjazdu!";
                    }

                    carrierSpan.appendChild(nameSpan);
                    cell.appendChild(carrierSpan);
                });
            } else {
                const brak = document.createElement("span"); brak.textContent = " No data"; brak.style.color = "red"; brak.style.fontWeight = "bold"; cell.appendChild(brak);
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
            } catch(e) {}

            if (ordersCount == null && mapping[subwave] && mapping[subwave].sumE) {
                ordersCount = mapping[subwave].sumE;
            }

            if (ordersCount !== null && ordersCount !== undefined) {
                const row = cell.closest('tr');
                if (row) {
                    let targetCell = totesColIndex !== -1 ? row.children[totesColIndex] : null;

                    const ordersSpan = document.createElement("span");
                    ordersSpan.innerHTML = `📦 <b>${ordersCount} orders</b>`;

                    Object.assign(ordersSpan.style, {
                        color: "black",
                        background: "#DFD799",
                        fontSize: "11px",
                        borderRadius: "5px",
                        padding: "2px 6px",
                        marginRight: "10px",
                        float: "right",
                        display: "inline-block"
                    });

                    if (targetCell) {
                        targetCell.appendChild(ordersSpan);
                    } else {
                        cell.appendChild(ordersSpan);
                    }
                }
            }
        }

        const rows = Array.from(document.querySelectorAll('tr')).filter(tr => tr.querySelectorAll('td').length > 0);
        for (let row of rows) {
            const tds = row.querySelectorAll('td');
            for (let cell of tds) {
                const txt = cell.textContent.trim();
                if (["Started", "Sorting", "Sorted", "All orders received","Finished","Deleted",].includes(txt)) {
                    cell.style.fontWeight = 'bold'; cell.style.color = '#fff'; cell.style.borderRadius = '7px'; cell.style.padding = '2px 6px'; cell.title = txt;
                    if (txt === "Started") { cell.style.backgroundColor = '#ff9800'; cell.textContent = '🔜 ' + txt; }
                    else if (txt === "Sorting") { cell.style.backgroundColor = '#03a9f4'; cell.textContent = '♻️ ' + txt; }
                    else if (txt === "Sorted") { cell.style.backgroundColor = '#4caf50'; cell.textContent = '♻️' + txt; }
                    else if (txt === "All orders received") { cell.style.backgroundColor = '#9c27b0'; cell.textContent = '💯 ' + txt; }
                     else if (txt === "Finished") { cell.style.backgroundColor = '#C0C0C0'; cell.textContent = '✅ ' + txt; }
                    else if (txt === "Deleted") { cell.style.backgroundColor = '#FF0000'; cell.textContent = '🚮 ' + txt;cell.title = 'ForceRelease'; }
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
                        td.style.fontWeight = 'bold'; td.style.borderRadius = '7px'; td.title = 'Attention: time exceeded 25 minutes. Check status subwave in WMS';
                        if (hasNew) {
                            td.classList.add('blink-alert');
                            td.textContent = '⚠️ ' + txt;
                        }
                        else {
                            td.style.backgroundColor = '#ffcccc';
                            td.textContent = '🔔 ' + txt;
                        }
                    }
                }
            }
        }
    }

    // ==============================
    // CZĘŚĆ 3: AUTO REFRESH
    // ==============================

    class osr_overview_extended {
        expectedTabs = ['OSR\u00A0overview', 'OSR\u00A0Overview/Capacity'];
        tabName = '';
        tab;
        table;
        refreshButtonId = '';
        auto_refresh_enabled = true;
        nextRefreshTime = 0;

        constructor() {
            this.setNextRefreshTime();
        }

        setNextRefreshTime() {
             this.nextRefreshTime = Date.now() + (REFRESH_DELAY_SECONDS * 1000);
        }

        clock() {
            let self = this;
            setInterval(() => {
                let now = Date.now();
                self.addReferences();
                self.checkTable();

                let switchContainer = document.querySelector('.pplx-switch');
                let timer = document.getElementById('AR_refresh_in');

                if (
                    self.expectedTabs.indexOf(self.tabName) == -1 ||
                    self.table == undefined ||
                    self.table.querySelectorAll('tr').length == 0
                ) {
                    self.resetInterface();
                    if(switchContainer) switchContainer.classList.add('inactive');
                    if(timer) timer.parentElement.style.color = 'gray';
                    return;
                } else {
                    if(switchContainer) switchContainer.classList.remove('inactive');
                    if(timer) timer.parentElement.style.color = '#1565c0';
                }

                self.addInterface();
                self.checkGrafanaStatus();

                let checkbox = document.getElementById('AR_checkbox');
                if (checkbox && !checkbox.getAttribute('data-click-attached')) {
                    checkbox.setAttribute('data-click-attached', 'true');
                    checkbox.addEventListener('change', function() {
                         self.auto_refresh_enabled = this.checked;
                         if (self.auto_refresh_enabled) self.setNextRefreshTime();
                    });
                }
                self.updateAutoRefresh(now);
            }, 1000);
        }

        resetInterface() {
            const dialog = document.getElementById('AR_dialog');
            if (dialog) dialog.style.display = 'none';
            const gDialog = document.getElementById('AR_grafana_wrapper');
            if (gDialog) gDialog.style.display = 'none';
        }

        checkTable() {
            if (!this.expectedTabs.includes(this.tabName)) {
                this.table = undefined;
                return;
            }
            if (!this.tab) return;
            let tables = this.tab.querySelectorAll('.dx-select-checkboxes-hidden');
            tables.forEach((el) => {
                if (!el.classList.contains('dx-pointer-events-none')) this.table = el;
            });
        }

        addReferences() {
            let css_class = 'tabButtonTopSelected';
            if (document.querySelectorAll('.' + css_class).length == 0) css_class = 'tabButtonTopSelectedOver';

            let selectedTabMenuItem = document.querySelector('.' + css_class);
            let selectedTabName = selectedTabMenuItem ? selectedTabMenuItem.textContent : '';
            let selectedTabObj;
            let containers = document.querySelectorAll('.af2WebDataControlContainer');

            containers.forEach((el) => {
                let tabWrapper = el.parentElement.parentElement;
                if (tabWrapper && tabWrapper.style.visibility !== 'hidden' && tabWrapper.style.display !== 'none' && tabWrapper.offsetHeight > 0) {
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
                style.innerHTML = `
                    .pplx-switch { position: relative; display: inline-block; width: 40px; height: 20px; }
                    .pplx-switch input { opacity: 0; width: 0; height: 0; }
                    .pplx-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #d32f2f; transition: .4s; border-radius: 20px; }
                    .pplx-slider:before { position: absolute; content: ""; height: 14px; width: 14px; left: 3px; bottom: 3px; background-color: white; transition: .4s; border-radius: 50%; }
                    input:checked + .pplx-slider { background-color: #388e3c; }
                    input:checked + .pplx-slider:before { transform: translateX(20px); }
                    .pplx-switch.inactive .pplx-slider { background-color: #9e9e9e !important; cursor: not-allowed; }
                    .pplx-switch.inactive input:checked + .pplx-slider { background-color: #9e9e9e !important; }
                `;
                document.head.appendChild(style);
            }

            let dialog = document.getElementById('AR_dialog');
            if (!dialog) {
                dialog = document.createElement('div');
                dialog.id = 'AR_dialog';
                Object.assign(dialog.style, {
                    zIndex: 999999, backgroundColor: 'rgba(255, 255, 255, 0.95)', position: 'fixed',
                    bottom: '32px', left: '10px', border: '1px solid #aaa', borderRadius: '4px',
                    padding: '4px 10px', boxShadow: '0 2px 5px rgba(0,0,0,0.2)', fontSize: '12px',
                    fontFamily: 'Arial, sans-serif', textAlign: 'center', minWidth: '90px'
                });
                dialog.innerHTML = `
                    <div style="font-weight:bold; color:#333; font-size: 11px; margin-bottom: 3px;">Auto-Refresh</div>
                    <div style="display: flex; align-items: center; justify-content: center; gap: 8px;">
                        <div style="font-size:14px; font-weight:bold; color:#1565c0; min-width: 30px; text-align: right;">
                            <span id="AR_refresh_in">15</span> s
                        </div>
                        <label class="pplx-switch" style="margin: 0;">
                          <input type="checkbox" id="AR_checkbox" ${this.auto_refresh_enabled ? 'checked' : ''}>
                          <span class="pplx-slider round"></span>
                        </label>
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
                    zIndex: 999999, backgroundColor: 'rgba(255, 255, 255, 0.95)', position: 'fixed',
                    bottom: '32px', left: '135px', border: '1px solid #aaa', borderRadius: '4px',
                    padding: '7.1px 10px', boxShadow: '0 2px 5px rgba(0,0,0,0.2)', fontSize: '12px',
                    fontFamily: 'Arial, sans-serif', textAlign: 'center', minWidth: '90px',
                    height: 'auto', display: 'block'
                });
                gDialog.innerHTML = `
                    <div style="font-weight:bold; color:#1565c0; font-size:11px;">Grafana Sync:</div>
                    <div id="AR_grafana_text" style="font-size:11px; font-weight:bold; color:#d32f2f; margin-top:2px;">--</div>
                `;
                document.body.appendChild(gDialog);
            } else {
                gDialog.style.display = 'block';
            }
        }

        checkGrafanaStatus() {
            const el = document.getElementById('AR_grafana_text');
            const box = document.getElementById('AR_grafana_wrapper');
            if (!el || !box) return;

            const rawData = GM_getValue('unified_grafana_data');

            if (!rawData || rawData.length < 5) {
                 el.style.color = '#d32f2f'; el.textContent = 'ERROR'; box.style.borderColor = '#d32f2f';
                 return;
            }

            let grafanaKeys = new Set();
            try {
                const parsed = JSON.parse(rawData);
                parsed.forEach(row => {
                    if (row.c0) grafanaKeys.add(row.c0.trim().replace(/\s+/g, ''));
                    if (row.workGroup) grafanaKeys.add(row.workGroup.trim().replace(/\s+/g, ''));
                });
            } catch (e) {
                 el.style.color = '#d32f2f'; el.textContent = 'JSON ERR';
                 return;
            }

            const uiCells = Array.from(document.querySelectorAll('td'))
                                 .map(td => td.textContent.trim())
                                 .filter(txt => /^MULT\d+/.test(txt));

            if (uiCells.length === 0) {
                el.style.color = '#4caf50'; el.textContent = 'READY'; box.style.borderColor = '#4caf50';
                return;
            }

            let foundCount = 0;
            let missingCount = 0;
            const uniqueUiMults = [...new Set(uiCells.map(t => t.match(/^MULT\d+/)[0].replace(/\s+/g, '')))];

            uniqueUiMults.forEach(key => {
                if (grafanaKeys.has(key)) foundCount++;
                else missingCount++;
            });

            if (missingCount === 0) {
                el.style.color = '#4caf50'; el.textContent = 'Data send to KiSoft'; box.style.borderColor = '#4caf50';
            } else if (foundCount > 0) {
                el.style.color = '#ff9800'; el.textContent = `PARTIAL (${foundCount}/${uniqueUiMults.length})`; box.style.borderColor = '#ff9800';
            } else {
                el.style.color = '#d32f2f'; el.textContent = 'bad data'; box.style.borderColor = '#d32f2f';
            }
        }

        refreshData() {
            let realKiSoftButtons = document.querySelectorAll('div[eventproxy^="isc_Af2WebReloadButton_"]');
            let clickedCount = 0;

            realKiSoftButtons.forEach(btn => {
                if (btn && btn.offsetWidth > 0 && btn.offsetHeight > 0) {
                    const style = window.getComputedStyle(btn);
                    if (style.display !== 'none' && style.visibility !== 'hidden') {
                        let proxyName = btn.getAttribute('eventproxy');
                        if (proxyName) {
                            try {
                                if (typeof window[proxyName] !== 'undefined') window[proxyName].click();
                                else eval(proxyName + ".click()");
                                clickedCount++;
                            } catch (e) {
                                const evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
                                btn.dispatchEvent(evt);
                                clickedCount++;
                            }
                        }
                    }
                }
            });
            console.log(`[Auto-Refresh] Precyzyjnie zaatakowano ukryte przyciski 'isc_Af2WebReloadButton_X': ${clickedCount}`);
        }

        updateAutoRefresh(now) {
            let self = this;
            if (!self.auto_refresh_enabled) return false;
            let remainingTime = Math.ceil((self.nextRefreshTime - now) / 1000);

            if (remainingTime <= 0) {
                self.refreshData();
                self.setNextRefreshTime();
                remainingTime = REFRESH_DELAY_SECONDS;
            }

            let el = document.getElementById('AR_refresh_in');
            if (el) el.innerHTML = remainingTime;
        }
    }

    loadData();

  function highlightItemSorterBackground() {
        const containers = document.querySelectorAll('.af2WebDialog, .af2WebDataControlContainer, .dx-datagrid');

        containers.forEach(container => {
            const headerRows = Array.from(container.querySelectorAll('tr')).filter(tr => {
                const txt = tr.textContent.toUpperCase();
                // DODANO: Nasłuch na kolumny Subwave w Item Sorterze
                return txt.includes('OSR_STATION_RELEASE_ON') ||
                       txt.includes('SORTER_STATION_LOCKED') ||
                       txt.includes('OSR_STATION_LOCKED') ||
                       txt.includes('LOCKED') ||
                       txt.includes('SORTER_STATION_RELEASE_ON') ||
                       txt.includes('STATION') ||
                       txt.includes('TOKEN') ||
                       txt.includes('SUBWAVEW_RELEASED') ||
                       txt.includes('SUBWAVE_RELEASED');
            });

            if (headerRows.length === 0) return;

            const headerRow = headerRows[0];

            const headers = Array.from(headerRow.querySelectorAll('td, th')).map(h => {
                let titleSpan = h.querySelector('.overflow-ellipsis');
                return titleSpan ? titleSpan.textContent.trim().toUpperCase() : h.textContent.trim().toUpperCase();
            });

            const colorRules = {
                "OSR_STATION_LOCKED": { "Y": "#f44336", "N": "#4caf50" },
                "SORTER_STATION_LOCKED": { "Y": "#f44336", "N": "#4caf50" },
                "LOCKED": { "Y": "#f44336", "N": "#4caf50" },
                "OSR_STATION_RELEASE_ON": { "Y": "#4caf50", "N": "#f44336" },
                "SORTER_STATION_RELEASE_ON": { "Y": "#4caf50", "N": "#f44336" },
                "TOKEN": { "M1": "#3366FF", "M2": "#3399FF" }
            };

            const textRules = {
                "SORTER_STATION_LOCKED": { "Y": "🔒 Locked", "N": "🔓 Unlocked" },
                "OSR_STATION_LOCKED": { "Y": "🔒 Locked", "N": "🔓 Unlocked" },
                "LOCKED": { "Y": "🔒 Locked", "N": "🔓 Unlocked" },
                "SORTER_STATION_RELEASE_ON": { "Y": "🔓 Unlocked", "N": "🔒 Locked" },
                "OSR_STATION_RELEASE_ON": { "Y": "🔓 Unlocked", "N": "🔒 Locked" },
                "TOKEN": { "M1": "PTS 2", "M2": "PTS 1" }
            };

            const dataRows = Array.from(container.querySelectorAll('tr.dx-data-row, tr')).filter(tr => tr !== headerRow && tr.querySelectorAll('td').length > 0);

            for (let row of dataRows) {
                const cells = row.querySelectorAll('td');

                cells.forEach((td, index) => {
                    const txt = td.textContent.trim().toUpperCase();
                    let columnName = headers[index];

                    // --- LOGIKA Y/N ---
                    if (txt === "Y" || txt === "N") {
                        if (columnName && colorRules[columnName] && colorRules[columnName][txt]) {
                            td.style.backgroundColor = colorRules[columnName][txt];
                            td.style.color = '#fff'; td.style.fontWeight = 'bold'; td.style.borderRadius = '5px'; td.style.textAlign = 'center';
                            if (textRules[columnName] && textRules[columnName][txt]) td.textContent = textRules[columnName][txt];
                        } else {
                            td.style.backgroundColor = (txt === "Y") ? '#4caf50' : '#f44336';
                            td.style.color = '#fff'; td.style.fontWeight = 'bold'; td.style.borderRadius = '5px';
                        }
                    }

                    // --- LOGIKA TOKEN ---
                    if (columnName === "TOKEN" && (txt === "M1" || txt === "M2")) {
                        td.style.backgroundColor = colorRules["TOKEN"][txt];
                        td.style.color = '#fff'; td.style.fontWeight = 'bold'; td.style.borderRadius = '5px'; td.style.textAlign = 'center';
                        if (textRules["TOKEN"][txt]) td.textContent = textRules["TOKEN"][txt];
                    }

                    // --- LOGIKA STATION ---
                    if (columnName === "STATION" && txt.startsWith("PA")) {
                        if (txt.includes("->")) return;

                        let stationNum = parseInt(txt.replace("PA", ""), 10);
                        let areaName = null; let areaColor = null;

                        if (stationNum >= 101 && stationNum <= 110) { areaName = "Consumables Area"; areaColor = "#3366FF"; }
                        else if (stationNum >= 111 && stationNum <= 120) { areaName = "PickTower Area"; areaColor = "#3366FF"; }
                        else if (stationNum >= 201 && stationNum <= 210) { areaName = "ShipDock Area"; areaColor = "#3399FF"; }
                        else if (stationNum >= 211 && stationNum <= 220) { areaName = "Consumables Area"; areaColor = "#3399FF"; }

                        if (areaName && areaColor) {
                            td.style.backgroundColor = areaColor;
                            td.style.color = '#fff'; td.style.fontWeight = 'bold'; td.style.borderRadius = '5px'; td.style.textAlign = 'center';
                            td.textContent = `${txt} -> ${areaName}`;
                        }
                    }

                    // --- NOWA LOGIKA: ORDERS DLA MULT W ITEM SORTER ---
                    if ((columnName === "SUBWAVES_RELEASED" || columnName === "SUBWAVES_RELEASED") && txt.startsWith("MULT")) {
                        // Zabezpieczenie przed dublowaniem z MutationObserver
                        if (td.querySelector('.kisoft-itemsorter-orders')) return;

                        const subwave = txt.match(/^MULT\d+/)?.[0]?.replace(/\s+/g, '');
                        if (!subwave) return;

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
                        } catch(e) {}

                        if (ordersCount == null && mapping[subwave] && mapping[subwave].sumE) {
                            ordersCount = mapping[subwave].sumE;
                        }

                        if (ordersCount !== null && ordersCount !== undefined) {
                            const ordersSpan = document.createElement("span");
                            ordersSpan.className = "kisoft-itemsorter-orders";
                            ordersSpan.innerHTML = ` <b>${ordersCount} orders</b>`;
                            Object.assign(ordersSpan.style, {
                                color: "black", background: "DFD799", fontWeight: "bold",
                                fontSize: "11px", borderRadius: "5px", padding: "2px 6px",
                                marginLeft: "3px", verticalAlign: "middle", display: "inline-block"
                            });
                            td.appendChild(ordersSpan);
                        }
                    }
                });
            }
        });
    }

    let observerTimeout = null;
    const observer = new MutationObserver(() => {
        clearTimeout(observerTimeout);
        observerTimeout = setTimeout(() => {
            observer.disconnect();

            if (isOsrOverview()) {
                addHeader();
                addCsvInput();
                mapToKiSoft();
            }

            highlightItemSorterBackground();
            observer.observe(document.body, { childList: true, subtree: true });
        }, 100);
    });

    observer.observe(document.body, { childList: true, subtree: true });

    if (isOsrOverview()) {
        addCsvInput();
        mapToKiSoft();
    }
    highlightItemSorterBackground();

    if (!CURRENT_URL.includes('gdcgrafana-eu.logistics.corp')) {
        setTimeout(() => {
            const autoRefresher = new osr_overview_extended();
            autoRefresher.clock();
            console.log("Auto-refresher started");
        }, 2000);
    }
})();