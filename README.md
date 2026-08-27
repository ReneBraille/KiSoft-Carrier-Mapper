# KiSoft Carrier Mapper – Opis funkjonalny

## Cel skryptu

KiSoft Carrier Mapper do rozszerzenie Tampermonkey integrujące dane z Grafany z systemem KiSoft. Jego zadaniem jest automatyczny pobieranie informacji o subwave, carrierach, OSR, UPO oraz statusach operacyjnych i prezentowanie ich bezpośrednio w interfejsie KiSoft.

---

# 1. Integracja Grafana ↔ KiSoft

Skrypt działa jednoczeście na Grafanie oraz w KiSoft.

### Po stronie Grafany:

* automatycznie odczytuje dane z tabeli,
* wyszukuje rekordy MULT,
* pobiera informacje o:

  * Grupa robocza (MULT),
  * Typ zamówienia (STD/VIP),
  * Przewoźnik,
  * Wysyłka według daty,
  * Zamówienia,
  * Linie,
  * Zadane elementy,
  * Grupa wysyłkowa (OSR),
* zapasje dane do pamiuci Tampermonkey jako wspólny magazyn danych.

### Po stronie KiSoft:

* pobiera zapisane dane,
* mapowanie buduje strukturę,
* przypisje carrierów do subwave,
* rozdziela zamówienia STD i VIP,
* buduje statystyki OSR,
* zapasje dane lokalnie do dalszy obliczek.

---

# 2. Synchronizacja danych z Grafany

Funkcja Sync umozliwia:

* ręczne pobranie danych,
* automatyczny pobieranie danych,
* wykrywanie zmian w danych,
* Pomijanie Rendowania Jeśli Dane Nie Uległy Zmianie,
* wymuszenie pełnego odświeżenia.

Synchronizacja aktualizuje:

* przewoźnik,
* daty wysyłek,
* OSR,
* statystyki STD/VIP,
* Dane Używane do Obliczania UPO.

---

# 3. Mapowanie danych do KiSoft

Po synchronizacji skrypt:

* znajduje odpowiednie wiersze MULT w tabeli,
* podfala rozpoznaje,
* przypisje informacje o przewoźniku,
* wyświetła dodatkowe dane w tabeli,
* aktualizuje statusy i oznaczenia.

---

# 4. Podsumowanie panelu OSR

Dla każdego OSR obliczane są:

* liczba zamówiec,
* liczba itemów,
* UPO,
* podfala Licby Gotowicza,
* statystyki OSR1_A1,
* statystyki OSR1_A2.

Dane są prezentowane w dedykowanym panelu podsumowania. Wyniki wyliczane są dynamicznie na podstawie aktualnych danych KiSoft i Grafana. (Funkcjonalność rozwijana w kolejnych wersjach na podstawie przypisań OSR i statusów subwave.)

---

# 5. Historia i analiza UPO

Skrypt zapisuje historię UPO dla:

* OSR1_A1
* OSR1_A2

Próbki są zapisywane cyklicznie i wykorzystywane do budowania trendów.

---

# 6. UPO Trend Panel

Dedykowany panel „UPO Trend” pokazuje:

### Aktualne UPO

* bieżące UPO dla każdego OSR.

### Średnie historyczne

* 1h średnia (poprzednia pelna godzina),
* Średnia 2h,
* Średnia 3h,
* Średnia 4h.

### Historia Porównanie

* wzrost UPO,
* spadek UPO,
* brak danych historycznicz.

Panel prezentuje różnić pomię aktualnym wynikiem a średnić z poprzednicza godzina.

---

# 7. Grupowanie historia UPO

Historia UPO jest grupowana według pelnych godzin.

Przykład:

* 18:00–18:59
* 19:00–19:59
* 20:00–20:59

Dzieki temu średnie sł liszone dla pełnych godzin, a nie dla prapradkowych próbek czasowych.

---

# 8. Debuguj historii UPO

Diagnostyka narana:

### Pokaż historyczny

Pozwala wyświetlić:

* wszystkie zaisane próbki UPO,
* podział według godzin,
* liczba próbek w każdej godzinie,
* wyliczone średnie.

Pomaga w weryfikacii poprawnośni obliczeń trendów.

---

# 9. Trybuńska skupienia

Tryb Trybu Fokusu umozliwia filtranie widoku.

Po Właczeniu:

* ukrywane niepasujące wiersze,
* widoczne pozostajczy tylko rekordy spełniające kryteria,
* wyświetlana jest liczba aktualnie widoczynch rekordów,
* aktywny przycisk jest wyróżny wizualnie.

---

# 10. Filtr nosny

Dodano filtranie po carrzerze.

Funkcja umozliwia:

* wyszukiwanie konkretnego carriera,
* zawężanie listy wyników,
* współprać z Trybu ostrości,
* wizualne oznaczenie aktywnego filtra.

---

# 11. Kolorowanie statusów Sortowanie elementów

Analiza automatyczna Skrypt Kolumny:

* ZAMKNIJTY,
* OSR_STACJA_ZABLOKOWANA,
* SORTER_STACJA_ZABLOKOWANA,
* OSR_STATION_RELEASE_ON,
* TOKEN,
* SUBWAVE_RELEASED.

Na podstawie wartości Y/N komórki są kolorowane odpowiednimi kolorami ostrzegawczymi lub informacyjnymi.

---

# 12. Automatyka odświańska

Wbudowany mechanizm automatyczny odśnia:

* Krzywa Przyciski Przeładuj KiSoft,
* wykonie automatyczne odświeżenie,
* pokazuje licznik czasu do kolejego odświeżenia,
* poza pracować bez ręcznego odświeżania widoku.

---

# 13. Zapisywanie danych lokalnie

Skrypt wykorzystuje:

### lokalnyPrzechowywanie

zrób prachywanii:

* mapowanie,
* przypisań OSR,
* historia UPO,
* ustawień użytkownika.

### Przechowywanie Tampermonkey

do wymiany danych pomędzy:

* Grafanć,
* KiSoft.

---

# 14. Mapy Magazynu

Dodano dwa nowe przyciski:

### 🗺️ Zaplanuj podawajć

Zaplanuj Otwiery Strefy Infeed.

### 🗺️ Zaplanuj Skelletę

Plan Otwiera automatyki / Skellet.

---

# 15. Mapa Interaktywny podgląd

Nowa mapa podglądu Zawiera:

### Zoom

* powiakszanie kólkiem myszy,
* zakres od 0,3x do 8x.

### Przesuwanie

* proroganie mapy myszką,
* płynna nawigacja po planie.

### Zmiana rozmiaru okna

* możliwość skalowania okna mapy,
* ograniczenia minimalnicza i maksymalnicza wymiarów.

### Przycisk zamknićcia

* zamykanie okna jednym kliknićiem,
* automatyczny usuwanie informacji stan przyśniski.

### Aktywny stan przycisku

* aktualnie otwarta mapa jest podświetlona,
* stan aktywny znika po zamkniuciu okna.

---

# Podsumowanie

KiSoft Carrier Mapper rozszerza standardowy interfejs KiSoft o synchronizację z Grafaną, analiza carrierów, statystyki OSR, monitorowanie UPO, historia wydajności, filtranie danych, automatychne odświeżanie oraz interaktywne mapy magazynu. Dzieki temu użytkownik otrzymuje complet informacii operacyjnych bez koniecnych przełęczy pomędzy wieloma systemami.
