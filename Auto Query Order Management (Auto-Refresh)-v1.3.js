// ==UserScript==
// @name        Auto Query Order Management (Auto-Refresh)
// @namespace    http://tampermonkey.net/
// @version      v1.3
// @description  Auto Query with Table Display + Refresh
// @author       vasyl.hospodyn@cevalogistics.com
// @match        https://gdcgrafana-eu.logistics.corp/d/dOHkIABY83AGEIHMDTLOPSPRODSTD/ageing-heatmap-detail-prod?orgId=1*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // Konfiguracja czasu odświeżania
    const REFRESH_INTERVAL_MS = 1200000;

    class rl_class {
        constructor() {
            this.timerInterval = null
            this.nextRefreshTime = null;
        }

        // SQL 
        sqlRequest(sql) {
            sql = sql.replaceAll("`", "\\\"");
            let sd = new Date();
            let ed = new Date();
            const requestPromise = fetch("https://gdcgrafana-eu.logistics.corp/api/ds/query", {
                "headers": {
                    "accept": "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9,pl;q=0.8",
                    "content-type": "application/json",
                    "sec-ch-ua": "\"Chromium\";v=\"116\", \"Not)A;Brand\";v=\"24\", \"Google Chrome\";v=\"116\"",
                    "sec-ch-ua-mobile": "?0",
                    "sec-ch-ua-platform": "\"Windows\"",
                    "sec-fetch-dest": "empty",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-site": "same-origin",
                    "x-grafana-org-id": "1"
                },
                "referrer": location.href,
                "referrerPolicy": "strict-origin-when-cross-origin",
                "body": "{\"queries\":[{\"refId\":\"A\",\"datasource\":{\"uid\":\"mFpJIAhVk\",\"type\":\"postgres\"},\"rawSql\":\"" + sql + "\",\"format\":\"table\",\"datasourceId\":108,\"intervalMs\":60000,\"maxDataPoints\":1447}],\"range\":{\"from\":\"" + sd.toISOString() + "\",\"to\":\"" + ed.toISOString() + "\",\"raw\":{\"from\":\"" + sd.toISOString() + "\",\"to\":\"" + ed.toISOString() + "\"}},\"from\":\"" + sd.getTime() + "\",\"to\":\"" + ed.getTime() + "\"}",
                "method": "POST",
                "mode": "cors",
                "credentials": "include"
            });
            return requestPromise;
        }

        // SQL>>Tablica
        retrieve_data(raw_data) {
            const data = [];
            if (raw_data && raw_data.results && raw_data.results.A && raw_data.results.A.frames && raw_data.results.A.frames[0]) {
                 $.each(raw_data.results.A.frames[0].data.values[0], function(a, b) {
                    let row = raw_data.results.A.frames[0].data.values;
                    let tempArray = {};
                    let cols = raw_data.results.A.frames[0].data.values.length;
                    for (let i = 0; i < cols; i++) {
                        let fieldName = raw_data.results.A.frames[0].schema.fields[i].name;
                        tempArray[fieldName] = row[i][a];
                    }
                    data[a] = tempArray;
                });
            }
            return data;
        }

        // Zapyt danych
        async getData(query) {
            try {
                let request = await this.sqlRequest(query);
                if (!request.ok) {
                    let error = await request.json();
                    console.log(error);
                    if (error.results === undefined) {
                        error = 'Unknown Error: ' + error.message;
                    } else {
                        error = error.results.A.error;
                    }
                    return { 'error': error };
                }
               let response = await request.json();
let data = this.retrieve_data(response);

data.forEach(row => {
    if (
        row.CARRIER_ID &&
        row.CARRIER_ID.toUpperCase() === 'CEVA'
    ) {
        row.CARRIER_ID = 'B2B-VIP';
    }
});

return data;
            } catch (e) {
                return { 'error': e.toString() };
            }
        }

        // Run SQL
        async runQuery() {
            // Aktualizacja statusu
            $('#status_info').html('⏳ Odświeżanie danych...').css('color', 'orange');

            let sql = " SELECT oh.`WORK_GROUP`, oh.`ORDER_TYPE`, oh.`CARRIER_ID`, TO_CHAR(oh.`SHIP_BY_DATE`, 'YYYY-MM-DD') as Ship_by_Date, Max(oh.`STATUS`), COUNT(DISTINCT oh.`ORDER_ID`) as Orders, SUM(ol.`QTY_ORDERED`) as Lines, SUM(ol.`QTY_TASKED`) as Tasked, SUM(ol.`QTY_SHIPPED`) as Shipped, oh.`SHIPMENT_GROUP` FROM `GODLX83P`.`ORDER_HEADER` oh JOIN `GODLX83P`.`ORDER_LINE` as ol on oh.`ORDER_ID` = ol.`ORDER_ID` WHERE oh.`ORDER_TYPE` IN ('B2C-STD','B2C-VIP', 'B2B-STD', 'B2B-VIP', 'ITM-CD') AND oh.`WORK_GROUP` like 'MULT1%' AND oh.`STATUS` in ('Allocated', 'Hold', 'In Progress', 'Picked', 'Released') GROUP BY oh.`WORK_GROUP`, oh.`ORDER_TYPE`, oh.`CARRIER_ID`, oh.`SHIP_BY_DATE`, oh.`SHIPMENT_GROUP`";

            let data = await this.getData(sql);
            let htmlContent = $('<div></div>');

            if (data.length && data.error === undefined) {
                let htmlTable = $('<table id="data_table" border="1" style="border-collapse: collapse; width: 100%; text-align: left;"></table>');
                let headers = '';
             
                Object.keys(data[0]).forEach((column) => {
                    headers += "<th style='padding: 8px; background-color: #8D6F64; color: white;'>" + column + "</th>";
                });
                htmlTable.append('<thead><tr>' + headers + '</tr></thead>');
                // dodaje dane do tabeli
                let tableBody = $('<tbody></tbody>');
                $.each(data, (i, row) => {
                    let rowHtml = "<tr>";
                    Object.keys(data[0]).forEach((column) => {
                        rowHtml += "<td style='padding: 8px;'>" + row[column] + "</td>";
                    });
                    rowHtml += "</tr>";
                    tableBody.append(rowHtml);
                });
                htmlTable.append(tableBody);
                htmlContent.append(htmlTable);

                // Aktualizacja statusu po sukcesie
                let now = new Date().toLocaleTimeString();
                $('#status_info').html('✅ Dane zaktualizowane: ' + now).css('color', 'green');

            } else {
                let errMsg = data.error ? data.error : "Brak danych lub błąd połączenia.";
                htmlContent.append('<div style="color: red; font-weight: bold;">Error: ' + errMsg + '</div>');
                $('#status_info').html('❌ Błąd aktualizacji').css('color', 'red');
            }
            $('#response_table').html(htmlContent);

            // Reset licznika czasu
            this.resetTimer();
        }

        startTimerDisplay() {
            // Aktualizacja licznika co sekundę
            setInterval(() => {
                if(this.nextRefreshTime) {
                    let diff = this.nextRefreshTime - new Date().getTime();
                    if(diff < 0) diff = 0;
                    let minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
                    let seconds = Math.floor((diff % (1000 * 60)) / 1000);
                    $('#timer_info').text(`Następne odświeżenie za: ${minutes}m ${seconds}s`);
                }
            }, 1000);
        }

        resetTimer() {
            this.nextRefreshTime = new Date().getTime() + REFRESH_INTERVAL_MS;
        }

        // Initialize the script
        async initialize() {
            // Dodanie stylów i kontenerów
            $('body').html(`
                <div style="background:#f0f0f0; padding:10px; border-bottom:1px solid #ccc; display:flex; justify-content:space-between; align-items:center; font-family: Arial, sans-serif;">
                    <div style="font-weight:bold; font-size:16px;">Raport SQL - Auto Query 1.3v</div>
                    <div>
                        <span id="status_info" style="margin-right:20px; font-weight:bold;">Inicjalizacja...</span>
                        <span id="timer_info" style="color:Black;"></span>
                    </div>
                </div>
                <div id="response_table" style="margin: 20px; font-family: Arial, sans-serif;"></div>
            `);

            // Pierwsze uruchomienie
            await this.runQuery();
            this.startTimerDisplay();

            // Ustawienie interwału
            setInterval(async () => {
                await this.runQuery();
            }, REFRESH_INTERVAL_MS);
        }
    }

    // Uruchomienie tylko jeśli hash to #TEST
    if (window.location.hash == "#TEST") {
        // Sprawdzenie czy jQuery jest załadowane
        const waitForJQuery = setInterval(() => {
            if (window.jQuery) {
                clearInterval(waitForJQuery);
                $(document).ready(async function() {
                    let rl = new rl_class();
                    rl.initialize();
                });
            }
        }, 100);
    }
})();
