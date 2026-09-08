# v1.0.34

- Restores automatic best SG bridge selection by RSSI with 8 dB hysteresis; no node is hard-pinned.
- Homey app branding changed to SG red (#E30613) with monochrome SG glyph so Homey renders the list/card icon red + white instead of blue/green.
- Restores the approved white/red SG LEDDim banner assets.
- BLE/TX/recovery protocol behavior otherwise unchanged from v1.0.31/1.0.33.

> Visual-only repack of v1.0.32: white app artwork with red SG LEDDim branding. Runtime code is unchanged.

# v1.0.32

**A/B-test:** Denne versjonen er identisk med v1.0.31 i TX/status/recovery-logikk, men bridge er hardt låst til `@ND44D0` (`A0:82:AC:03:44:D0`). Formålet er å sammenligne BLE/GATT-stabilitet direkte mot `@ND32C3`.

- Statusforbindelser kan ikke lenger bli markert som `CONN ready` etter fysisk BLE-frakobling eller mislykket 8004-abonnement.
- TX recovery prøver Homey `ble.find(preferredUuid)` før full `discover()`, for å hente en fersk advertisement uten unødvendig 10-sekunders scan.
- `Peripheral Not Found` ved lokal disconnect invaliderer cached advertisement.
- TX/status pre-emption, 400 ms linger, latest-wins og queue-wide recovery fra 1.0.30 er beholdt.

# SG LEDDim v1.0.28

**Compatibility:** This app is specifically for the older **SG Smart Gen1 LEDDim** dimmers that communicate over Bluetooth/CSRmesh. It is not a general SG Smart integration and is not intended for newer SG Smart/Gen2 products or gateway-based devices.

Changes in v1.0.28:
- Fixes accumulated `disconnect` listeners on Homey's reused `BlePeripheral` object. The previous listener is removed on reconnect and before local disconnect, preventing `MaxListenersExceededWarning`.
- Adds a short 400 ms TX idle linger after the desired queue becomes empty. A new command arriving in that window cancels disconnect and reuses the already prepared GATT link.
- The linger is not a heartbeat and does not keep BLE connected persistently.
- Queue-wide recovery, 5 s recovery circuit breaker, 5.5 s post-GATT freshness gate, CSRmesh framing/encryption, 25 ms fragment gap, and complete-packet retry are unchanged.

# SG LEDDim v1.0.24

TX stability build based directly on v1.0.23 diagnostics.

Changes:
- Before starting a NEW CSRmesh packet, if the current SG connection is >= 8.3 s old, disconnect and reconnect first. Never disconnect between 8003 and 8004.
- Added one shared preferred-bridge recovery owner. A failed cached connection hands recovery to one fresh-discovery routine instead of allowing queued commands to cascade into `Preferred SG bridge unavailable`.
- Recovery stays pinned to the same preferred bridge UUID and performs at most two fresh discovery/connect attempts.
- Status polling remains unchanged/off when configured off.
- CSRmesh packet format, encryption, 25 ms fragment gap, and complete-packet retry are unchanged.
- Verbose BLE timing remains enabled for validation.

### v1.0.30
- Fix: user TX now fully pre-empts an in-flight status connection. The old STATUS `_connecting` promise is invalidated/settled before TX opens its own GATT connection, so OFF/latest desired values are not stranded when a command arrives during `subscribe-8004` or service discovery.
- Status retry remains cancelled while TX is pending. TX/recovery framing, 400 ms linger, queue-wide cooldown and latest-wins behavior are otherwise unchanged.
- Added Homey-style SVG assets for the physical wall dimmer plus a separate red SG branding logo asset.
- Statusintervallet trer i kraft med en gang når du trykker **Lagre**. Appen trenger ikke restart ved Av/30 s/60 s/2 min/5 min.
