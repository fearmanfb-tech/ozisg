/**
 * tasarim_atolyesi.js — Faz 2: Sandbox'lı AI-CAD (JS-DSL) + Gerçek CSG Motoru
 * ─────────────────────────────────────────────────────────────
 * ESKİ MİMARİ (TAMAMEN KALDIRILDI): OpenSCAD metin üretimi + WASM derleme +
 * regex ile sahte kutu/silindir önizlemesi.
 *
 * CSG MİMARİSİ (Faz 1): Sahnedeki her şekil bir "Brush" (three-bvh-csg). Tüm
 * şekiller `csgRoot` adlı düz bir THREE.Group'un doğrudan çocuğu olarak
 * tutulur. Her çocuğun `.operation` alanı (ADDITION/SUBTRACTION/INTERSECTION)
 * o şeklin nihai modele nasıl katılacağını belirler. `recompute()`, boş bir
 * "kimlik" brush'tan başlayarak `evaluator.evaluate()`'i sırayla her çocuğa
 * uygular (soldan sağa katlama) — three-bvh-csg'nin kendi evaluateHierarchy()
 * önbellekleme mantığındaki doğrulanmış bir hatayı (bir şekil TAMAMEN
 * silindiğinde önbelleğin geçersiz kılınmaması) bilinçli olarak es geçer.
 *
 * AI-CAD MİMARİSİ (Faz 2 — GÜVENLİK KRİTİK):
 * AI (ai_cad.php), OpenSCAD DEĞİL, düz JavaScript üretir — ama bu kod ASLA
 * ana sayfa bağlamında `eval`/`new Function` ile çalıştırılmaz. Bunun yerine
 * `runSandboxed()`, `allow-same-origin` OLMAYAN bir `sandbox="allow-scripts"`
 * iframe açar (bu, iframe'e opak/benzersiz bir origin verir — ozisg.com'un
 * çerezlerine, localStorage/IndexedDB'sine — dolayısıyla Firebase Auth
 * oturumuna — erişemez). Kod orada izole bir "CAD" builder API'sine karşı
 * çalıştırılır ve SADECE düz sayısal veri (JSON'a benzer bir "node" listesi)
 * postMessage ile ana sayfaya döner. Ana sayfa bu veriyi asla güvenmez:
 * `validateAndConvertNodes()` her alanı whitelist'e ve sayısal sınırlara
 * karşı katı biçimde doğrular, sonra GERÇEK Brush nesnelerine çevirir.
 *
 * 3MF DIŞA AKTARIM (Faz 3): three.js'in resmi bir 3MFExporter'ı yok (sadece
 * import için 3MFLoader var), bu yüzden minimal ama geçerli bir 3MF paketini
 * (3D Manufacturing Format — aslında bir OPC/ZIP paketi: [Content_Types].xml
 * + _rels/.rels + 3D/3dmodel.model XML mesh'i) `fflate` ile kendimiz
 * yazıyoruz. Snapmaker Orca/BambuStudio/PrusaSlicer'ın tümü bu minimal
 * yapıyı kabul eder.
 *
 * Faz 4'e bırakılan: Firestore sipariş geçmişi/versiyonlama.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import { SVGLoader } from "three/addons/loaders/SVGLoader.js";
import { FontLoader } from "three/addons/loaders/FontLoader.js";
import { TextGeometry } from "three/addons/geometries/TextGeometry.js";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { zipSync, strToU8 } from "https://cdn.jsdelivr.net/npm/fflate@0.8.3/esm/browser.js";
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from "three-bvh-csg";
import { requireToolAccess, db, showToast } from "./app.js";
import {
    collection, addDoc, getDocs, getDoc, doc, deleteDoc,
    query, where, orderBy, limit, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ═══════════════════════════════════════════════════════════════
// 1. SAHNE / KAMERA / RENDERER
// ═══════════════════════════════════════════════════════════════

let scene, camera, renderer, controls;
let transformControls;
let currentTransformMode = "select"; // varsayılan araç: sadece seçim, gizmo yok
let resultMesh = null;
let selectionHelpers = [];
let measurePointA = null;
let measureLine = null;
let measureMarker = null;
let dragStartState = null; // {position, rotation, scale} — sürükleme başında yakalanır, undo için
// Shift+sürükle (Ölçekle aracında) orantılı kilit için global tuş durumu —
// transformControls'un "objectChange" olayı ham DOM olayını taşımadığından
// (sadece "bir şey değişti" der) shift'in o an basılı olup olmadığını ayrıca
// izlememiz gerekiyor.
let shiftHeldForScale = false;

// Döndür aracında Shift basılıyken 45°'lik adımlarla atlama (rotation snap);
// Shift bırakılınca / başka araca geçilince snap kapanır (null).
function applyRotationSnap() {
    if (!transformControls) return;
    const snap = shiftHeldForScale && currentTransformMode === "rotate";
    transformControls.setRotationSnap(snap ? THREE.MathUtils.degToRad(45) : null);
}
// Alt (Mac'te Option) basılı mı — Alt+sürükle ile hızlı çoğaltma için. Gizmo'nun
// "mouseDown" olayı ham DOM olayını taşımadığından (bkz. yukarıdaki Shift notu)
// burada ayrıca izleniyor.
let altHeld = false;
document.addEventListener("keydown", (e) => {
    if (e.key === "Shift") { shiftHeldForScale = true; applyRotationSnap(); }
    if (e.key === "Alt") altHeld = true;
});
document.addEventListener("keyup", (e) => {
    if (e.key === "Shift") { shiftHeldForScale = false; applyRotationSnap(); }
    if (e.key === "Alt") altHeld = false;
});
// Pencere odağı kaybolursa (Alt+Tab vb.) keyup hiç gelmez — Shift/Alt takılı kalmasın.
window.addEventListener("blur", () => { shiftHeldForScale = false; altHeld = false; applyRotationSnap(); });

// Etkileşimli Yüzüstü Yatır (Orca tarzı) modu: F ile girilir, seçili objenin bir
// yüzeyine tıklanınca o yüzey zemine bakacak şekilde yatırılır (bkz. layFlatSelected).
let layFlatMode = false;

// Alt+sürükle ile hızlı çoğaltma (Tinkercad): sürükleme başında oluşturulan kopyalar.
// {originals:[Brush], clones:[Brush]} — sürükleme bitince tek bir undo adımı olarak
// sahneye işlenir; iptal edilirse (Esc/araç değişimi) kopyalar silinir.
let altDup = null;

// Eşzamanlı (senkron) klon: pointermove/mouseDown içinde `await` kullanılamayacağı için
// createBrush() yerine geometri+materyal doğrudan klonlanır. Material.clone() renk,
// polygonOffset (Inlay) ve userData.extruder'ı da taşır; params kopyası inlay/extruder
// bayraklarını korur.
function cloneBrushSync(brush) {
    const clone = new Brush(brush.geometry.clone(), brush.material.clone());
    clone.name = `${brush.name} (kopya)`;
    clone.operation = brush.operation;
    clone.userData = { id: `node_${++idCounter}`, type: brush.userData.type, params: { ...brush.userData.params } };
    clone.position.copy(brush.position);
    clone.quaternion.copy(brush.quaternion);
    clone.scale.copy(brush.scale);
    clone.updateMatrixWorld(true);
    return clone;
}

// init3D() içinde atanır (sürükleme durumu o closure'da yaşıyor): devam eden
// gizmo/serbest gövde/çerçeve sürüklemesini İPTAL edip sahneyi temizler.
// İptal edilecek bir şey varsa true döner.
let cancelActiveDrag = () => false;

const evaluator = new Evaluator();
// NOT: csgRoot sadece bir THREE.Group — düzenleme sahnesindeki şekilleri (Brush)
// bir arada tutan organizasyonel bir kap. Gerçek CSG birleştirmesi recompute()
// içinde, evaluator.evaluate() ile children üzerinde MANUEL olarak (soldan sağa,
// her adımda bir öncekiyle) yapılır — three-bvh-csg'nin kendi evaluateHierarchy()
// önbellekleme mantığı bir şekil TAMAMEN silindiğinde önbelleği geçersiz kılmıyor
// (doğrulanmış kütüphane davranışı); bu yüzden her recompute() sıfırdan, güvenilir
// biçimde tüm zinciri yeniden hesaplar.
const csgRoot = new THREE.Group();
csgRoot.name = "Root";

// Faz 7 — Gizle/Göster: gizlenmiş (visible=false) şekiller viewport'ta ASLA
// tıklanamaz/seçilemez OLMALI (Outliner'dan hâlâ erişilebilirler) — bu yüzden
// viewport raycasting/çerçeve-seçimi yapan HER yer csgRoot.children yerine
// bu filtrelenmiş listeyi kullanır. Kilitli (locked) objeler İSE burada
// FİLTRELENMEZ — "Yine de seçilebilir" kuralı gereği kilit sadece taşımayı
// engeller, tıklamayı değil.
function visibleCsgChildren() {
    return csgRoot.children.filter((c) => c.visible);
}

// PREVIEW_MATERIAL: SADECE boş "kimlik" brush'ın (makeEmptyBrush) başlangıç
// materyali. Faz 5'ten itibaren HER PARAMETRİK şekil (box/cylinder/text/vb.)
// KENDİ rengini taşıyan AYRI bir MeshStandardMaterial örneğine sahip (bkz.
// createBrush()) — three-bvh-csg'nin Evaluator'ı varsayılan olarak zaten
// `useGroups = true` ile çalışır: evaluate() farklı materyalli iki brush'ı
// birleştirdiğinde onları TEK materyale indirgemek yerine geometri grupları +
// materyal DİZİSİ olarak korur. Bu yüzden recompute() artık sonuç materyalini
// ELLE EZMİYOR — kütüphanenin ürettiği diziyi olduğu gibi bırakıyor, bu da
// per-şekil renk sistemini "bedava" (mimari değişiklik gerektirmeden) mümkün
// kılıyor.
const DEFAULT_SHAPE_COLOR = "#2e6cd1";
const PREVIEW_MATERIAL = new THREE.MeshStandardMaterial({ color: DEFAULT_SHAPE_COLOR, roughness: 0.4, metalness: 0.1 });

function isValidHexColor(v) {
    return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
}

function makeEmptyBrush() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute([], 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute([], 2));
    geo.setIndex([]);
    const brush = new Brush(geo, PREVIEW_MATERIAL);
    brush.updateMatrixWorld();
    return brush;
}

function init3D() {
    const container = document.getElementById("canvas-container");
    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 2000);
    camera.position.set(70, 70, 70);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // ── CAD-STANDART FARE ŞEMASI (Fusion360/Tinkercad tarzı, Faz 5) ─────────
    // SOL tık: TAMAMEN bizim özel seçim/sürükleme/gizmo mantığımıza ayrılmış
    // (aşağıdaki pointerdown/move/up blokları) — OrbitControls SOL tıka ASLA
    // dokunmasın diye LEFT: null. SAĞ tık BASILI SÜRÜKLEME = Orbit (sahneyi
    // eksen etrafında döndür). ORTA tık (tekerlek basılı) SÜRÜKLEME = Pan
    // (kaydır). Tekerlek çevirme (zoom) bu haritalamadan bağımsız, her zaman
    // yakınlaştırma yapar. NOT: "Orbit"/"Pan" ARAÇ MODLARI (R/O ve H
    // kısayolları, bkz. setTransformMode) aktifken LEFT eşlemesi GEÇİCİ
    // olarak ROTATE/PAN'a çevrilir — sağ/orta tuşu olmayan trackpad
    // kullanıcıları için.
    controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    // Dokunmatik (tablet/telefon): TEK parmak = Orbit, İKİ parmak = Pinch-Zoom
    // + Pan. Bu zaten OrbitControls'ün varsayılanı — niyet kodda belgeli
    // olsun ve ileride yanlışlıkla değiştirilmesin diye açıkça yazıyoruz.
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

    // csgRoot normalde GÖRÜNMEZ (sadece kaynaşmış `resultMesh` render edilir),
    // ama sahneye eklenmesi iki şeyi mümkün kılıyor:
    //   1) Sürükleme sırasında ham (henüz CSG'lenmemiş) parçaları "patlamış
    //      görünüm" gibi anlık göstermek (bkz. transformControls "mouseDown"),
    //      pahalı tam CSG'yi HER kare değil, sürükleme bitince bir kez çalıştırmak.
    //   2) Viewport'ta tıkla-seç: raycaster doğrudan csgRoot.children'a karşı
    //      çalışır — bunun için sahneye ait olmaları GEREKMEZ, sadece güncel
    //      matrixWorld'e sahip olmaları yeterli, ama patlamış görünüm render'ı
    //      için sahnede olmaları lazım.
    scene.add(csgRoot);
    csgRoot.visible = false;

    transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setMode("translate"); // ilk seçilen araca geçildiğinde kullanılacak; "select" modunda zaten detach
    scene.add(transformControls.getHelper());

    transformControls.addEventListener("mouseDown", () => {
        controls.enabled = false;
        if (!selected) return;
        // Alt+sürükle (Taşı aracı): orijinal yerinde kalır, gizmo AYNI konumdaki yeni bir
        // kopyaya devredilir ve sürükleme onunla sürer. Kopya, mouseUp'ta tek undo
        // adımı olarak eklenir (bkz. aşağısı).
        altDup = null;
        if (altHeld && currentTransformMode === "translate" && !selected.userData.locked) {
            const original = selected;
            const clone = cloneBrushSync(original);
            csgRoot.add(clone);
            altDup = { originals: [original], clones: [clone] };
            selectNode(clone); // gizmo'yu kopyaya bağlar (sürükleme başlangıç değerleri aynı)
        }
        dragStartState = {
            position: selected.position.toArray(),
            rotation: [selected.rotation.x, selected.rotation.y, selected.rotation.z],
            scale: selected.scale.toArray(),
        };
        resultMesh.visible = false;
        csgRoot.visible = true; // sürüklerken ham parçaları göster (ucuz, CSG yok)
    });

    transformControls.addEventListener("objectChange", () => {
        if (!selected) return;
        // Shift+sürükle (Ölçekle aracında) = orantılı/uniform ölçek kilidi.
        // TransformControls'un tek-eksenli scale tutamaçları VARSAYILAN olarak
        // SADECE o ekseni değiştirir; Shift basılıyken en çok değişen ekseni
        // (aktif sürüklenen tutamaç) bulup aynı oranı DİĞER İKİ eksene de
        // elle uyguluyoruz.
        if (currentTransformMode === "scale" && shiftHeldForScale && dragStartState) {
            const orig = dragStartState.scale;
            const cur = selected.scale;
            const ratios = [cur.x / orig[0], cur.y / orig[1], cur.z / orig[2]];
            let dominant = 0, maxDelta = 0;
            ratios.forEach((r, i) => { const d = Math.abs(r - 1); if (d > maxDelta) { maxDelta = d; dominant = i; } });
            const ratio = ratios[dominant];
            selected.scale.set(orig[0] * ratio, orig[1] * ratio, orig[2] * ratio);
            selected.updateMatrixWorld();
        }
        // Manyetik Yüzey Kenetlenmesi (Faz 8) — SADECE Taşı modunda. En son
        // bilinen imleç konumundan (lastPointerClient — bkz. pointermove)
        // sahneye bir ışın yolla; SEÇİLİ OLMAYAN görünür bir cisme çarparsa
        // seçili objeyi çarpma noktasına TAŞI ve KENDİ Y ekseni (0,1,0) o
        // yüzeyin dünya-uzayı normaline bakacak şekilde DÖNDÜR — böylece bir
        // silindir/koni gibi eğik bir yüzeye bile doğru oturur. NOT: `raycaster`
        // ve `ndcFromEvent` bu fonksiyonun ALTINDA tanımlı olsa da, bu callback
        // sadece init3D() TAMAMEN çalıştıktan SONRA (bir olay anında) tetiklenir
        // — closure + JS'in çalışma zamanı sırası gereği bu güvenli.
        if (magneticSnapEnabled && currentTransformMode === "translate" && lastPointerClient) {
            raycaster.setFromCamera(ndcFromEvent(lastPointerClient), camera);
            const activeList = activeSelectionList();
            const candidates = visibleCsgChildren().filter((c) => !activeList.includes(c));
            const hits = raycaster.intersectObjects(candidates, false);
            if (hits.length > 0 && hits[0].face) {
                const hit = hits[0];
                selected.position.copy(hit.point);
                const worldNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
                selected.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), worldNormal);
                selected.updateMatrixWorld();
            }
        }
        // Sadece sarı tel-kafes takip etsin — ne CSG (pahalı) ne de Inspector'ı
        // yeniden çizmek (odak kaybı + gereksiz DOM churn) her karede yapılmaz;
        // Inspector sürükleme bitince (mouseUp) bir kez güncellenir.
        updateSelectionHelper();
    });

    transformControls.addEventListener("mouseUp", async () => {
        controls.enabled = true;
        csgRoot.visible = false;
        if (!selected || !dragStartState) { recompute(); return; }

        const brush = selected;
        const before = dragStartState;
        const after = {
            position: brush.position.toArray(),
            rotation: [brush.rotation.x, brush.rotation.y, brush.rotation.z],
            scale: brush.scale.toArray(),
        };
        dragStartState = null;

        // Alt+sürükle ile oluşturulan kopya: taşıma + ekleme TEK undo adımı olarak
        // işlenir (geri alınca kopya tamamen kalkar). Kopya zaten sahnede (mouseDown'da
        // eklendi); redo'da son konumuyla geri eklenir.
        if (altDup) {
            const dup = altDup;
            altDup = null;
            await execute({
                do() { dup.clones.forEach((c) => { if (!c.parent) csgRoot.add(c); }); },
                undo() { dup.clones.forEach((c) => csgRoot.remove(c)); },
            });
            recompute();
            renderOutliner();
            renderInspector();
            return;
        }

        const changed = JSON.stringify(before) !== JSON.stringify(after);
        if (changed) {
            await execute({
                do() { brush.position.fromArray(after.position); brush.rotation.set(...after.rotation); brush.scale.fromArray(after.scale); brush.updateMatrixWorld(); },
                undo() { brush.position.fromArray(before.position); brush.rotation.set(...before.rotation); brush.scale.fromArray(before.scale); brush.updateMatrixWorld(); },
            });
        }
        recompute();
        renderInspector();
    });

    // ── Viewport etkileşimi: TIKLA-SEÇ, ÇERÇEVEYLE ÇOKLU SEÇİM, SERBEST
    // GÖVDE SÜRÜKLEME ──────────────────────────────────────────────────
    // Araç modeli Fusion360 tarzı: varsayılan araç "Seç" — sadece seçim
    // yapılır, gizmo YOK. Boş alandan sürüklemek bir çerçeve (marquee) açar,
    // içine giren tüm şekilleri seçer. "Taşı" aracı açıkça seçildiğinde:
    // ok tutup TEK eksende (TransformControls, yukarıda) VEYA doğrudan
    // şeklin gövdesine basıp SERBEST zemin-düzlemi taşıması yapılabilir —
    // çoklu seçim varsa hepsi birlikte kayar.
    const raycaster = new THREE.Raycaster();
    const groundPlane = new THREE.Plane();
    const planeHit = new THREE.Vector3();
    let pointerDownPos = null;
    let dragCandidate = null;      // pointerdown'da vurulan Brush (eşik aşılmadan önce)
    let isBodyDragging = false;    // eşik aşıldı, gerçek serbest sürükleme sürüyor
    let dragGroup = null;          // sürüklenen TÜM brush'lar (tekil veya çoklu seçim)
    let dragGroupStart = null;     // [{brush, position}] — undo için
    let dragStartWorldPoint = null;
    let dragStartObjPos = null;
    let marqueeCandidate = false;  // boş alanda basıldı, henüz eşik aşılmadı
    let isMarqueeSelecting = false;
    let marqueeStartScreen = null;
    // Faz 8 — Hızlı Metin Düzenleme: bir CAD.text objesine ÇİFT TIKLAMAYI
    // tespit etmek için zaman damgası + hedef takibi (native 'dblclick'
    // yerine bilerek pointerdown/up akışımızın İÇİNDE, "sadece tıklama"
    // dalında tespit ediyoruz — böylece marquee/sürükleme ile çakışmaz).
    let lastClickTime = 0;
    let lastClickBrush = null;
    // Faz 8 — Manyetik Yüzey Kenetlenmesi: TransformControls'un "objectChange"
    // olayı fare pozisyonunu TAŞIMADIĞI için (sadece "obje değişti" der),
    // en son bilinen imleç konumunu AYRICA burada takip ediyoruz — aşağıdaki
    // genel pointermove dinleyicisi HER zaman (moddan bağımsız) günceller.
    let lastPointerClient = null;

    function ndcFromEvent(e) {
        const rect = renderer.domElement.getBoundingClientRect();
        return new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1
        );
    }
    function raycastGroundAt(e, y) {
        groundPlane.set(new THREE.Vector3(0, 1, 0), -y);
        raycaster.setFromCamera(ndcFromEvent(e), camera);
        return raycaster.ray.intersectPlane(groundPlane, planeHit) ? planeHit.clone() : null;
    }
    function worldToScreen(worldPos) {
        const v = worldPos.clone().project(camera);
        const rect = renderer.domElement.getBoundingClientRect();
        return { x: (v.x * 0.5 + 0.5) * rect.width, y: (-v.y * 0.5 + 0.5) * rect.height };
    }
    function getMarqueeEl() {
        let el = document.getElementById("marquee-box");
        if (!el) {
            el = document.createElement("div");
            el.id = "marquee-box";
            el.style.cssText = "position:absolute; border:1.5px solid var(--accent-primary); background:rgba(46,108,209,0.12); pointer-events:none; z-index:22; display:none;";
            document.getElementById("canvas-container").appendChild(el);
        }
        return el;
    }

    // Sürükleme İPTALİ (ESC veya araç değiştirme kısayolu). TransformControls.detach()
    // eksen bilgisini sıfırladığı için sürükleme ortasında çağrılırsa "mouseUp"
    // olayı HİÇ tetiklenmez → csgRoot görünür kalır, resultMesh gizli kalır,
    // OrbitControls kapalı kalır ("hayalet obje"). Burada mouseUp'ın yaptığı
    // temizliği elle yapıp objeyi sürükleme öncesi konumuna geri alıyoruz
    // (undo geçmişine bir şey yazılmaz — iptal edilen hareket hiç olmamış sayılır).
    // Alt+sürükle iptal edilirse geçici kopyaları sahneden sil, seçimi orijinallere iade et.
    function discardAltDuplicates() {
        if (!altDup) return;
        const { originals, clones } = altDup;
        altDup = null;
        clones.forEach((c) => csgRoot.remove(c));
        if (originals.length > 1) selectMultiple(originals); else selectNode(originals[0]);
    }

    cancelActiveDrag = function () {
        let cancelled = false;

        // 1) Serbest gövde sürükleme (Taşı aracında şekle basıp sürükleme)
        if (isBodyDragging) {
            if (dragGroupStart) {
                dragGroupStart.forEach(({ brush, position }) => { brush.position.fromArray(position); brush.updateMatrixWorld(); });
            }
            discardAltDuplicates();
            isBodyDragging = false;
            dragGroup = null;
            dragGroupStart = null;
            hideDragTooltip();
            cancelled = true;
        }
        dragCandidate = null;

        // 2) Gizmo (ok/halka/küp tutamacı) sürüklemesi
        if (transformControls.dragging) {
            discardAltDuplicates();
            if (selected && dragStartState) {
                selected.position.fromArray(dragStartState.position);
                selected.rotation.set(...dragStartState.rotation);
                selected.scale.fromArray(dragStartState.scale);
                selected.updateMatrixWorld();
            }
            dragStartState = null;
            transformControls.dragging = false;
            transformControls.axis = null;
            cancelled = true;
        }

        // 3) Çerçeve (marquee) seçimi
        if (isMarqueeSelecting || marqueeCandidate) {
            isMarqueeSelecting = false;
            marqueeCandidate = false;
            getMarqueeEl().style.display = "none";
            cancelled = true;
        }

        if (cancelled) {
            controls.enabled = true;
            csgRoot.visible = false;
            if (resultMesh) resultMesh.visible = true;
            pointerDownPos = null; // bırakılınca "tıklama" seçimi tetiklenmesin
            updateSelectionHelper();
            renderInspector();
        }
        return cancelled;
    };

    renderer.domElement.addEventListener("pointerdown", (e) => {
        // KRİTİK: sadece SOL tık bizim seçim/sürükleme mantığımızı tetiklesin.
        // Sağ tık (kamera kaydırma/pan) ve orta tık/tekerlek (yakınlaştırma)
        // TAMAMEN OrbitControls'e ait. "=== 0" yerine bilinen SAĞ(2)/ORTA(1)
        // değerlerini dışlıyoruz — bazı touchpad/kalem sürücüleri sol tık için
        // her zaman tam olarak 0 raporlamayabiliyor; bu daha toleranslı kontrol
        // sol tıkın yanlışlıkla reddedilmesini engelliyor.
        if (e.button === 1 || e.button === 2) return;
        // "Orbit"/"Pan" ARAÇ MODU aktifse (R/O veya H kısayolu ile girilir)
        // SOL tık TAMAMEN OrbitControls'e bırakılır (mouseButtons.LEFT o modda
        // ROTATE/PAN'a çevrilmiş durumda, bkz. setTransformMode) — bizim
        // seçim/sürükleme/marquee mantığımız bu modlarda devre dışı.
        if (currentTransformMode === "orbit" || currentTransformMode === "pan") return;
        pointerDownPos = { x: e.clientX, y: e.clientY };
        dragCandidate = null;
        isBodyDragging = false;
        marqueeCandidate = false;
        isMarqueeSelecting = false;
        if (transformControls.axis) return; // gizmo tutamacı tıklandı, bize düşen iş yok

        raycaster.setFromCamera(ndcFromEvent(e), camera);
        const hits = raycaster.intersectObjects(visibleCsgChildren(), false);
        if (hits.length > 0) {
            dragCandidate = hits[0].object;
        } else if (currentTransformMode === "select") {
            // Boş alan + Seç aracı → çerçeveyle çoklu seçim adayı
            marqueeCandidate = true;
            marqueeStartScreen = { x: e.clientX, y: e.clientY };
        }
    });

    renderer.domElement.addEventListener("pointermove", (e) => {
        lastPointerClient = { clientX: e.clientX, clientY: e.clientY };
        // ── Çerçeveyle çoklu seçim ──
        if (marqueeCandidate) {
            const moved = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
            if (!isMarqueeSelecting) {
                if (moved <= 5) return;
                isMarqueeSelecting = true;
                controls.enabled = false;
            }
            const rect = renderer.domElement.getBoundingClientRect();
            const x0 = marqueeStartScreen.x - rect.left, y0 = marqueeStartScreen.y - rect.top;
            const x1 = e.clientX - rect.left, y1 = e.clientY - rect.top;
            const el = getMarqueeEl();
            el.style.left = Math.min(x0, x1) + "px";
            el.style.top = Math.min(y0, y1) + "px";
            el.style.width = Math.abs(x1 - x0) + "px";
            el.style.height = Math.abs(y1 - y0) + "px";
            el.style.display = "block";
            return;
        }

        // ── Serbest gövde sürükleme (sadece "Taşı" aracında) ──
        // Kilitli bir şekil ASLA fareyle sürüklenemez — "TransformControls
        // bağlanamaz" kuralının serbest-sürükleme karşılığı.
        if (!dragCandidate || transformControls.axis || currentTransformMode !== "translate" || dragCandidate.userData.locked) return;
        const moved = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);

        if (!isBodyDragging) {
            if (moved <= 5) return;
            isBodyDragging = true;
            controls.enabled = false;
            // Sürüklenen zaten çoklu seçimin bir parçasıysa TÜM grup birlikte
            // taşınır (kilitli üyeler HARİÇ — bir kilitli obje bir komşusunun
            // sürüklemesine "yolcu" olarak binip kazara taşınmasın); değilse
            // tekil seçime geçilir (eski davranış).
            if (multiSelected.length > 1 && multiSelected.includes(dragCandidate)) {
                dragGroup = multiSelected.filter((b) => !b.userData.locked);
            } else {
                if (selected !== dragCandidate) selectNode(dragCandidate);
                dragGroup = [dragCandidate];
            }
            // Alt+sürükle: orijinaller yerinde kalır, sürükleme AYNI konumdaki kopyalar
            // üzerinden devam eder (Tinkercad "hızlı çoğaltma").
            if (e.altKey || altHeld) {
                const originals = dragGroup;
                const clones = originals.map(cloneBrushSync);
                clones.forEach((c) => csgRoot.add(c));
                dragCandidate = clones[originals.indexOf(dragCandidate)];
                dragGroup = clones;
                altDup = { originals, clones };
                if (clones.length > 1) selectMultiple(clones); else selectNode(clones[0]);
            }
            dragGroupStart = dragGroup.map((b) => ({ brush: b, position: b.position.toArray() }));
            dragStartObjPos = dragCandidate.position.clone();
            dragStartWorldPoint = raycastGroundAt(e, dragStartObjPos.y);
            resultMesh.visible = false;
            csgRoot.visible = true;
            showDragTooltip();
        }

        const current = raycastGroundAt(e, dragStartObjPos.y);
        if (!current || !dragStartWorldPoint) return;
        const dx = current.x - dragStartWorldPoint.x;
        const dz = current.z - dragStartWorldPoint.z;
        dragGroupStart.forEach(({ brush, position }) => {
            brush.position.x = snapValue(position[0] + dx);
            brush.position.z = snapValue(position[2] + dz);
            brush.updateMatrixWorld();
        });
        updateSelectionHelper();
        updateDragTooltip(e, dx, dz);
    });

    renderer.domElement.addEventListener("pointerup", async (e) => {
        // Sağ/orta tık bırakılışını tamamen yok say — aksi halde eski (sol
        // tıktan kalma) pointerDownPos ile yanlışlıkla bir "tıklama" seçimi
        // tetiklenebiliyordu.
        if ((e.button === 1 || e.button === 2) && !isMarqueeSelecting && !isBodyDragging) return;
        if (currentTransformMode === "orbit" || currentTransformMode === "pan") return;

        // ── Çerçeve bırakıldı: içindeki şekilleri seç ──
        if (isMarqueeSelecting) {
            isMarqueeSelecting = false;
            marqueeCandidate = false;
            controls.enabled = true;
            getMarqueeEl().style.display = "none";

            const rect = renderer.domElement.getBoundingClientRect();
            const x0 = marqueeStartScreen.x - rect.left, y0 = marqueeStartScreen.y - rect.top;
            const x1 = e.clientX - rect.left, y1 = e.clientY - rect.top;
            const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
            const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);

            const inside = visibleCsgChildren().filter((b) => {
                const p = worldToScreen(new THREE.Box3().setFromObject(b).getCenter(new THREE.Vector3()));
                return p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
            });
            if (inside.length > 1) selectMultiple(inside);
            else if (inside.length === 1) selectNode(inside[0]);
            else selectNode(null);
            return;
        }
        marqueeCandidate = false;

        // ── Serbest sürükleme bırakıldı: konumu kalıcı yap (undo'lu) ──
        if (isBodyDragging) {
            isBodyDragging = false;
            controls.enabled = true;
            csgRoot.visible = false;
            hideDragTooltip();

            const before = dragGroupStart;
            const after = before.map(({ brush }) => ({ brush, position: brush.position.toArray() }));
            dragGroupStart = null;
            dragGroup = null;
            dragCandidate = null;
            const changed = before.some((b, i) => b.position[0] !== after[i].position[0] || b.position[2] !== after[i].position[2]);

            if (altDup) {
                // Alt+sürükle: kopyalar (mouseDown'daki gibi) TEK undo adımıyla işlenir.
                const dup = altDup;
                altDup = null;
                await execute({
                    do() { dup.clones.forEach((c) => { if (!c.parent) csgRoot.add(c); }); },
                    undo() { dup.clones.forEach((c) => csgRoot.remove(c)); },
                });
                recompute();
                renderOutliner();
            } else if (changed) {
                await execute({
                    do() { after.forEach(({ brush, position }) => { brush.position.fromArray(position); brush.updateMatrixWorld(); }); },
                    undo() { before.forEach(({ brush, position }) => { brush.position.fromArray(position); brush.updateMatrixWorld(); }); },
                });
                recompute();
            } else if (resultMesh) {
                resultMesh.visible = true;
            }
            renderInspector();
            return;
        }
        dragCandidate = null;

        // ── Sadece TIKLAMA (sürükleme değil) ──
        if (transformControls.dragging) return;
        if (!pointerDownPos) return;
        const moved = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
        pointerDownPos = null;
        if (moved > 5) return; // sürükleyerek kamera döndürme, tıklama değil

        raycaster.setFromCamera(ndcFromEvent(e), camera);

        // ── Etkileşimli Yüzüstü Yatır: tıklanan yüzey zemine bakacak ──
        // Sadece SEÇİLİ objelere ışın atılır (öndeki başka bir obje engellemesin).
        if (layFlatMode) {
            const hit = raycaster.intersectObjects(activeSelectionList(), false)[0];
            if (hit && hit.face) {
                const worldNormal = hit.face.normal.clone()
                    .applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld))
                    .normalize();
                window.exitLayFlatMode(true);
                await window.layFlatToWorldNormal(worldNormal);
            } else {
                document.getElementById("status-msg").innerText = "Seçili objenin bir yüzeyine tıklayın (Esc: iptal).";
            }
            return;
        }

        // ── Hızlı Metin Düzenleme (Faz 8): bir CAD.text objesine ÇİFT
        // TIKLAMA tespiti — Ölçüm modu HARİÇ (orada iki tıklama zaten "A/B
        // noktası" anlamına geliyor, çakışmasın diye burada devre dışı).
        if (currentTransformMode !== "measure") {
            const textHits = raycaster.intersectObjects(visibleCsgChildren(), false);
            const hitBrush = textHits.length > 0 ? textHits[0].object : null;
            const isTextHit = hitBrush && hitBrush.userData.type === "text" && !hitBrush.userData.locked;
            const now = performance.now();
            if (isTextHit && hitBrush === lastClickBrush && now - lastClickTime < 400) {
                lastClickTime = 0;
                lastClickBrush = null;
                selectNode(hitBrush);
                openQuickTextEdit(hitBrush, e);
                return;
            }
            lastClickTime = isTextHit ? now : 0;
            lastClickBrush = isTextHit ? hitBrush : null;
        }

        // ── Ölçüm aracı: iki nokta tıkla, arası mesafeyi mm cinsinden göster ──
        if (currentTransformMode === "measure") {
            const hits = raycaster.intersectObjects(visibleCsgChildren(), false);
            let point;
            if (hits.length > 0) {
                point = hits[0].point.clone();
            } else {
                const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
                const p = new THREE.Vector3();
                if (!raycaster.ray.intersectPlane(ground, p)) return;
                point = p;
            }
            if (!measurePointA) {
                measurePointA = point;
                showMeasureMarker(point);
            } else {
                finishMeasurement(measurePointA, point);
                measurePointA = null;
            }
            return;
        }

        // ── Normal seçim ──
        const hits = raycaster.intersectObjects(visibleCsgChildren(), false);
        // Shift+Sol Tık: tıklanan şekli aktif çoklu-seçime EKLER/ondan ÇIKARIR
        // (Tinkercad/Fusion360 "toggle-select" kuralı). Boş alana shift+tık
        // hiçbir şeyi değiştirmez (marquee zaten Seç aracında boş alanı yönetiyor).
        if (e.shiftKey) {
            if (hits.length > 0) toggleSelection(hits[0].object);
            return;
        }
        if (hits.length > 0) {
            selectNode(hits[0].object);
            // Metin nesnesi seçildiyse Inspector'daki "Metin" kutusuna doğrudan odaklan.
            if (hits[0].object.userData.type === "text") focusInspectorTextInput();
        } else selectNode(null);
    });

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight1.position.set(100, 200, 50);
    scene.add(dirLight1);
    const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.3);
    dirLight2.position.set(-100, 100, -50);
    scene.add(dirLight2);

    const gridHelper = new THREE.GridHelper(200, 20, 0x000000, 0x000000);
    gridHelper.material.opacity = 0.1;
    gridHelper.material.transparent = true;
    scene.add(gridHelper);
    scene.add(new THREE.AxesHelper(50));

    window.addEventListener("resize", onWindowResize, false);
    renderer.domElement.addEventListener("pointerdown", () => { renderer.domElement.focus(); });
    initSidebarToggle();
    initShapePanelToggle();
    initShapeSearch();
    animate();
}

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
    updateMeasureLabelPosition();
    updateViewCube();
}

// ── Hızlı Görünümler + ViewCube (Faz 5) ─────────────────────────────────
// Kamerayı hedefe (controls.target) olan MEVCUT mesafeyi koruyarak verilen
// yön vektöründen bakacak şekilde uçurur — "Home" gibi sabit bir mesafeye
// sıfırlamaz, kullanıcının o anki yakınlaştırmasını korur.
const VIEW_DIRECTIONS = {
    front: [0, 0, 1], back: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0],
    top: [0, 1, 0.0001], bottom: [0, -1, 0.0001], iso: [1, 1, 1],
};
function flyToDirection(view) {
    const dir = new THREE.Vector3(...(VIEW_DIRECTIONS[view] || VIEW_DIRECTIONS.iso)).normalize();
    // Faz 12 DÜZELTME: eskiden mevcut controls.target (kullanıcı daha önce pan
    // yapmışsa modelin merkezinden KAYMIŞ olabilir) hedef alınıyordu — bu
    // yüzden izometrik vb. görünüme uçarken tasarım ekranın kenarına
    // kayabiliyordu. Uçmadan HEMEN ÖNCE, focusSelected()'daki mantığın aynısı
    // ile (seçili nesne varsa o, yoksa nihai resultMesh) BoundingBox merkezi
    // yeni target yapılıyor — tasarım her zaman ekranın ortasında kalır.
    const focusTarget = selected || resultMesh;
    if (focusTarget) {
        const box = new THREE.Box3().setFromObject(focusTarget);
        if (!box.isEmpty()) controls.target.copy(box.getCenter(new THREE.Vector3()));
    }
    const target = controls.target.clone();
    const dist = Math.max(40, camera.position.distanceTo(target));
    camera.position.copy(target).addScaledVector(dir, dist);
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
    controls.update();
}
window.setQuickView = function (view) { flyToDirection(view); };
window.snapViewCube = function (face) { flyToDirection(face); };

// ViewCube'ü İKİNCİ bir WebGL sahnesi AÇMADAN (performans) — sadece kameranın
// quaternion'ından türetilen bir CSS 3D transform ile senkronize ediyoruz.
function updateViewCube() {
    const cubeEl = document.getElementById("view-cube-inner");
    if (!cubeEl || !camera) return;
    const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
    cubeEl.style.transform = `rotateX(${THREE.MathUtils.radToDeg(-euler.x)}deg) rotateY(${THREE.MathUtils.radToDeg(euler.y)}deg)`;
}

// ── mm/cm Birim Göstergesi (Faz 5) ──────────────────────────────────────
// KASITLI KAPSAM: SADECE salt-okunur HUD gösterimini etkiler. Inspector'daki
// DÜZENLENEBİLİR sayısal alanlar (Boyutlar/Konum/Döndürme) bilerek HER ZAMAN
// mm kalır — bir birim dönüşümü/geri-dönüşüm hatası fuar öncesi gerçek
// geometri parametrelerini bozabilir; bu risk bu aşamada alınmıyor.
let displayUnit = "mm";
function formatLength(mm) {
    return displayUnit === "cm" ? `${(mm / 10).toFixed(2)} cm` : `${mm.toFixed(1)} mm`;
}
window.toggleUnit = function () {
    displayUnit = displayUnit === "mm" ? "cm" : "mm";
    const btn = document.getElementById("btn-unit-toggle");
    if (btn) btn.textContent = displayUnit;
    updateHUD();
};

// Üst araç çubuğunu (≤860px) hamburger menüsüyle aç/kapat.
window.toggleToolbarMobile = function () {
    document.getElementById("viewport-toolbar")?.classList.toggle("mobile-open");
};

// Yardım/Kısayollar modalı (Faz 7). `show` verilmezse mevcut durumu tersine
// çevirir (toolbar butonu ve `?` kısayolu için); açık/kapalı state'i CSS
// `.open` sınıfıyla yönetilir (overlay zaten `display:none` varsayılan).
window.toggleHelpModal = function (show) {
    const overlay = document.getElementById("help-modal-overlay");
    if (!overlay) return;
    const willShow = typeof show === "boolean" ? show : !overlay.classList.contains("open");
    overlay.classList.toggle("open", willShow);
    if (willShow) refreshIcons();
};

// Sürüklerken canlı mm okuması — Tinkercad'in sürükleme sırasında gösterdiği
// "0.00 / 6.00" ölçü etiketine benzer, imlecin yanında konumlanan basit bir
// HTML tooltip. Sadece görsel geri bildirim; hesaplamayı etkilemiyor.
function showDragTooltip() {
    let el = document.getElementById("drag-tooltip");
    if (!el) {
        el = document.createElement("div");
        el.id = "drag-tooltip";
        el.style.cssText = "position:absolute; pointer-events:none; background:rgba(0,0,0,0.75); color:#fff; padding:4px 8px; border-radius:6px; font:600 11px 'Fira Code',monospace; z-index:25; white-space:nowrap; transform:translate(12px, -50%);";
        document.getElementById("canvas-container").appendChild(el);
    }
    el.style.display = "block";
}
function updateDragTooltip(e, dx, dz) {
    const el = document.getElementById("drag-tooltip");
    if (!el) return;
    const rect = renderer.domElement.getBoundingClientRect();
    el.style.left = `${e.clientX - rect.left}px`;
    el.style.top = `${e.clientY - rect.top}px`;
    el.textContent = `ΔX: ${dx.toFixed(1)}mm  ΔZ: ${dz.toFixed(1)}mm`;
}
function hideDragTooltip() {
    const el = document.getElementById("drag-tooltip");
    if (el) el.style.display = "none";
}

// Ölçüm aracı — ilk tıklanan noktayı küçük bir küre ile işaretler.
// NOT: measurePointA'ya DOKUNMAZ — çağıran (pointerup) zaten ayarlıyor;
// burada bir clearMeasurement() çağırmak onu hemen sıfırlayıp ikinci
// tıklamanın asla "B noktası" sayılmamasına yol açan gerçek bir hataydı.
function showMeasureMarker(point) {
    if (measureMarker) { scene.remove(measureMarker); measureMarker.geometry.dispose(); measureMarker = null; }
    if (measureLine) { scene.remove(measureLine); measureLine.geometry.dispose(); measureLine = null; }
    const el = document.getElementById("measure-label");
    if (el) el.style.display = "none";
    const geo = new THREE.SphereGeometry(0.8, 12, 8);
    measureMarker = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xfacc15, depthTest: false }));
    measureMarker.position.copy(point);
    measureMarker.renderOrder = 999;
    scene.add(measureMarker);
}

// İki nokta arasına çizgi çeker + mesafeyi (mm) ekranda sabit bir etiket
// olarak gösterir (kamera dönse de okunabilir kalsın diye 3D metin değil,
// dünya→ekran izdüşümüyle güncellenen basit bir HTML etiket kullanıyoruz).
function finishMeasurement(a, b) {
    if (measureMarker) { scene.remove(measureMarker); measureMarker.geometry.dispose(); measureMarker = null; }
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    measureLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xfacc15, depthTest: false }));
    measureLine.renderOrder = 999;
    scene.add(measureLine);

    const dist = a.distanceTo(b);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    let el = document.getElementById("measure-label");
    if (!el) {
        el = document.createElement("div");
        el.id = "measure-label";
        el.style.cssText = "position:absolute; pointer-events:none; background:rgba(250,204,21,0.95); color:#1e293b; padding:4px 10px; border-radius:6px; font:700 12px 'Fira Code',monospace; z-index:25; white-space:nowrap; transform:translate(-50%, -130%);";
        document.getElementById("canvas-container").appendChild(el);
    }
    el.textContent = `${dist.toFixed(2)} mm`;
    el.dataset.worldX = mid.x; el.dataset.worldY = mid.y; el.dataset.worldZ = mid.z;
    el.style.display = "block";
}

function clearMeasurement() {
    if (measureLine) { scene.remove(measureLine); measureLine.geometry.dispose(); measureLine = null; }
    if (measureMarker) { scene.remove(measureMarker); measureMarker.geometry.dispose(); measureMarker = null; }
    measurePointA = null;
    const el = document.getElementById("measure-label");
    if (el) el.style.display = "none";
}

// Ölçüm etiketinin ekran konumunu her karede güncelle (kamera hareket etse
// bile ölçülen orta noktanın üzerinde asılı kalsın).
function updateMeasureLabelPosition() {
    const el = document.getElementById("measure-label");
    if (!el || el.style.display === "none" || !el.dataset.worldX) return;
    const world = new THREE.Vector3(parseFloat(el.dataset.worldX), parseFloat(el.dataset.worldY), parseFloat(el.dataset.worldZ));
    const v = world.project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    el.style.left = `${(v.x * 0.5 + 0.5) * rect.width}px`;
    el.style.top = `${(-v.y * 0.5 + 0.5) * rect.height}px`;
}

function onWindowResize() {
    const container = document.getElementById("canvas-container");
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
}

// Sol paneli daralt/genişlet — daha geniş viewport isteyen "profesyonel CAD
// hissi" için. Tercih localStorage'da kalıcı; panel CSS geçişi bitince
// (transitionend) viewport'un gerçek piksel genişliği değiştiği için
// renderer/kamera yeniden boyutlandırılıyor (yoksa görüntü gerilir/bozulur).
function initSidebarToggle() {
    const sidebar = document.querySelector(".sidebar-panel");
    const layout = document.querySelector(".studio-layout");
    const btn = document.getElementById("sidebar-toggle");
    if (!sidebar || !btn) return;

    // Faz 6: bu panel artık SAĞDA (Şekil Kütüphanesi ile yer değiştirdi) —
    // ok yönü buna göre: açıkken panel sağa doğru genişlediği için "▶",
    // kapalıyken viewport'tan sağa doğru "geri getir" anlamında "◀".
    function applyCollapsed(collapsed) {
        sidebar.classList.toggle("collapsed", collapsed);
        layout.classList.toggle("sidebar-collapsed", collapsed);
        btn.textContent = collapsed ? "◀" : "▶";
    }

    // Masaüstünde varsayılan AÇIK mantıklı (yeterli yer var); ≤860px'te
    // (mobil/tablet) panel artık `position:absolute` bir ÇEKMECE olduğu için
    // varsayılan AÇIK kalırsa 3D görünümü TAMAMEN kapatır — kullanıcı daha
    // önce AÇIKÇA bir tercih kaydetmediyse (localStorage boşsa) mobilde
    // varsayılanı KAPALI'ya çeviriyoruz. Kullanıcının kendi tercihi varsa ona
    // her zaman saygı duyulur.
    const savedPref = localStorage.getItem("ozisg_atolyesi_sidebar_collapsed");
    const stored = savedPref !== null ? savedPref === "1" : window.innerWidth <= 860;
    applyCollapsed(stored);

    sidebar.addEventListener("transitionend", (e) => {
        if (e.propertyName === "width") onWindowResize();
    });

    window.toggleSidebar = function () {
        const collapsed = !sidebar.classList.contains("collapsed");
        applyCollapsed(collapsed);
        localStorage.setItem("ozisg_atolyesi_sidebar_collapsed", collapsed ? "1" : "0");
    };
    btn.addEventListener("click", window.toggleSidebar);
}

// Şekil Kütüphanesi paneli — aynı aç/kapa deseni, sağ tarafta.
function initShapePanelToggle() {
    const panel = document.getElementById("shape-panel");
    const layout = document.querySelector(".studio-layout");
    const btn = document.getElementById("shape-panel-toggle");
    if (!panel || !btn) return;

    // Faz 6: bu panel artık SOLDA (Inspector/Model Ağacı paneliyle yer
    // değiştirdi) — ok yönü buna göre: açıkken "◀", kapalıyken "▶".
    function applyCollapsed(collapsed) {
        panel.classList.toggle("collapsed", collapsed);
        layout.classList.toggle("shape-panel-collapsed", collapsed);
        btn.textContent = collapsed ? "▶" : "◀";
    }

    // Aynı mobil-varsayılan-kapalı mantığı (bkz. initSidebarToggle) — kullanıcı
    // tercihi kaydedilmemişse ≤860px'te varsayılan KAPALI.
    const savedPref = localStorage.getItem("ozisg_atolyesi_shapepanel_collapsed");
    const stored = savedPref !== null ? savedPref === "1" : window.innerWidth <= 860;
    applyCollapsed(stored);

    panel.addEventListener("transitionend", (e) => {
        if (e.propertyName === "width") onWindowResize();
    });

    btn.addEventListener("click", () => {
        const collapsed = !panel.classList.contains("collapsed");
        applyCollapsed(collapsed);
        localStorage.setItem("ozisg_atolyesi_shapepanel_collapsed", collapsed ? "1" : "0");
    });
}

// Şekil Kütüphanesi — Tinkercad'in kategorili/aranabilir ızgarasının hafif
// muadili. Her giriş tek tıkla addPrimitive(type) çağırır.
// Faz 7 — İKON SİSTEMİ: Lucide (CDN'den yüklü, window.lucide global'i).
// Her dinamik render fonksiyonu kendi innerHTML'ini yazdıktan SONRA bunu
// çağırır — Lucide, sayfadaki TÜM dönüştürülmemiş <i data-lucide="...">
// etiketlerini tarayıp inline SVG'ye çevirir (zaten dönüştürülmüş <svg>'lere
// dokunmaz). window.lucide CDN'den yüklenemezse (ör. ağ hatası) sessizce
// atlanır — emoji yerine boş bir alan kalır ama uygulama ÇÖKMEZ.
function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === "function") {
        window.lucide.createIcons();
    }
}

const SHAPE_LIBRARY = [
    { type: "box", icon: "box", label: "Küp" },
    { type: "roundedbox", icon: "square", label: "Yuvarlak Köşeli Küp" },
    { type: "cylinder", icon: "cylinder", label: "Silindir" },
    { type: "sphere", icon: "circle", label: "Küre" },
    { type: "cone", icon: "cone", label: "Koni" },
    { type: "pyramid", icon: "pyramid", label: "Piramit" },
    { type: "triprism", icon: "triangle", label: "Üçgen Prizma" },
    { type: "hexprism", icon: "hexagon", label: "Altıgen Prizma" },
    { type: "torus", icon: "donut", label: "Simit" },
    { type: "tube", icon: "circle-dashed", label: "Tüp/Halka" },
    { type: "dome", icon: "moon", label: "Kubbe" },
    { type: "icosahedron", icon: "gem", label: "İkosahedron" },
    { type: "star", icon: "star", label: "Yıldız" },
    { type: "heart", icon: "heart", label: "Kalp" },
    { type: "text", icon: "type", label: "Metin" },
];

function renderShapeGrid(filter = "") {
    const grid = document.getElementById("shape-grid");
    if (!grid) return;
    const q = filter.trim().toLocaleLowerCase("tr");
    const items = q ? SHAPE_LIBRARY.filter((s) => s.label.toLocaleLowerCase("tr").includes(q)) : SHAPE_LIBRARY;
    if (items.length === 0) {
        grid.innerHTML = `<div class="shape-grid-empty">Eşleşen şekil yok.</div>`;
        return;
    }
    grid.innerHTML = items.map((s) => `
        <button class="shape-btn" title="${s.label} Ekle" onclick="window.addPrimitive('${s.type}')">
            <span class="shape-icon"><i data-lucide="${s.icon}"></i></span>
            <span class="shape-label">${s.label}</span>
        </button>
    `).join("");
    refreshIcons();
}

function initShapeSearch() {
    const input = document.getElementById("shape-search-input");
    renderShapeGrid();
    if (input) input.addEventListener("input", () => renderShapeGrid(input.value));
}

// Araç çubuğundaki İçe/Dışa Aktar açılır menüleri — panel gizle mekanizmasıyla
// aynı basit toggle deseni, `.dropdown-menu` master.css'teki hazır stil.
window.toggleToolbarMenu = function (btn) {
    const menu = btn.nextElementSibling;
    const willShow = menu.style.display !== "block";
    document.querySelectorAll(".toolbar-dropdown .dropdown-menu").forEach((m) => { m.style.display = "none"; });
    menu.style.display = willShow ? "block" : "none";
};
document.addEventListener("click", (e) => {
    if (!e.target.closest(".toolbar-dropdown")) {
        document.querySelectorAll(".toolbar-dropdown .dropdown-menu").forEach((m) => { m.style.display = "none"; });
    }
});

window.resetCamera = function () {
    camera.position.set(70, 70, 70);
    controls.target.set(0, 0, 0);
    controls.update();
};

window.focusSelected = function () {
    const target = selected ? selected : resultMesh;
    if (!target) return window.resetCamera();
    const box = new THREE.Box3().setFromObject(target);
    if (box.isEmpty()) return window.resetCamera();
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 5);
    const dist = maxDim * 2.2;
    controls.target.copy(center);
    camera.position.set(center.x + dist, center.y + dist, center.z + dist);
    controls.update();
};

// ═══════════════════════════════════════════════════════════════
// 2. KISAYOLLAR (F / Delete / Ctrl+Z / Ctrl+Y / G-R-S)
// ═══════════════════════════════════════════════════════════════

// 'select' | 'translate' | 'rotate' | 'scale' — gizmo SADECE Taşı/Döndür/
// Ölçekle araçlarından biri aktifken görünür; Seç aracında (varsayılan) hiç
// gösterilmez, tek iş seçim yapmaktır (Fusion360 tarzı: önce seç, sonra
// açıkça bir aracı etkinleştir).
window.setTransformMode = function (mode) {
    // Devam eden bir sürükleme varken araç değişirse (Q/G/S/R/H... kısayolu),
    // detach() "mouseUp"ı yutacağı için önce sürüklemeyi iptal edip sahneyi temizle.
    cancelActiveDrag();
    window.exitLayFlatMode(true); // araç değişince "yüzüstü yatır" seçim modundan çık
    if (currentTransformMode === "measure" && mode !== "measure") clearMeasurement();
    // Orbit/Pan modu BIRAKILIYORSA: SOL tık'ı bizim seçim mantığımıza iade et
    // (mouseButtons.LEFT'i geçici ROTATE/PAN atamasından null'a geri çevir).
    if ((currentTransformMode === "orbit" || currentTransformMode === "pan") && mode !== currentTransformMode) {
        controls.mouseButtons.LEFT = null;
    }
    currentTransformMode = mode;
    if (mode === "orbit" || mode === "pan") {
        // Ayrık "Orbit"/"Pan" ARAÇ MODU (R/O ve H kısayolları) — sağ/orta
        // fare tuşu olmayan trackpad kullanıcıları için SOL tık'ı GEÇİCİ
        // olarak kamera kontrolüne devrediyoruz. Gizmo bu modlarda gösterilmez.
        transformControls.detach();
        controls.mouseButtons.LEFT = mode === "orbit" ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    } else if (mode === "select" || mode === "measure") {
        transformControls.detach();
    } else {
        transformControls.setMode(mode);
        if (selected && !selected.userData.locked) transformControls.attach(selected);
        else transformControls.detach();
    }
    applyRotationSnap();
    document.querySelectorAll("[data-transform-mode]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.transformMode === mode);
    });
};

document.addEventListener("keydown", function (e) {
    const tag = document.activeElement ? document.activeElement.tagName : "";
    const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

    if (e.ctrlKey && e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); window.undo(); return; }
    if (e.ctrlKey && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z")) && !typing) { e.preventDefault(); window.redo(); return; }
    // Ctrl+D: Çoğalt — tarayıcının "sayfayı yer imlerine ekle" kısayolunu
    // bilerek eziyoruz (tüm tasarım araçlarındaki evrensel "çoğalt" kısayolu).
    if (e.ctrlKey && e.key.toLowerCase() === "d" && !typing) { e.preventDefault(); window.duplicateSelected(); return; }
    // Ctrl+C / Ctrl+V: Kopyala / Yapıştır — Ctrl+D'den (anında/aynı-yerde
    // çoğaltma) FARKLI: bir "pano" durumu tutar, farklı zamanlarda birden
    // çok kez yapıştırılabilir.
    if (e.ctrlKey && e.key.toLowerCase() === "c" && !typing) { e.preventDefault(); window.copySelected(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === "v" && !typing) { e.preventDefault(); window.pasteClipboard(); return; }
    if (typing) return;
    // KRİTİK: Ctrl/Cmd/Alt basılıyken hiçbir tek-tuş kısayolumuz ateşlenmesin —
    // aksi halde Ctrl+R (yenile), Ctrl+Shift+R (sert yenile), Ctrl+F (bul),
    // Ctrl+S (kaydet) gibi TARAYICI kısayollarını "r"/"f"/"s" harfi eşleştiği
    // için ele geçirip preventDefault ile engelliyorduk (gerçek bir hata,
    // kullanıcı sayfayı yenileyemiyordu).
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // F: Yüzüstü Yatır (Orca tarzı) — Shift+F: Seçiliye Odaklan (eski F davranışı).
    if (e.key.toLowerCase() === "f") { e.preventDefault(); if (e.shiftKey) window.focusSelected(); else window.layFlatSelected(); }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); window.deleteSelected(); }
    // Esc: ÖNCE Yardım modalı açıksa onu kapat; sonra devam eden sürükleme
    // varsa SADECE onu iptal et (seçim korunur); hiçbiri yoksa seçimi temizle
    // (AI üretiminden sonra otomatik seçilen son parçayı hızlıca "bırakmak" için).
    if (e.key === "Escape") {
        e.preventDefault();
        const helpOverlay = document.getElementById("help-modal-overlay");
        if (helpOverlay && helpOverlay.classList.contains("open")) { window.toggleHelpModal(false); return; }
        if (window.exitLayFlatMode()) return; // önce yüzüstü yatırma modunu iptal et
        if (cancelActiveDrag()) return;
        selectNode(null);
    }
    // Q/G/S: Fusion360/Blender kuralı — Seç / Taşı / Ölçekle.
    if (e.key.toLowerCase() === "q") { e.preventDefault(); window.setTransformMode("select"); }
    if (e.key.toLowerCase() === "g") { e.preventDefault(); window.setTransformMode("translate"); }
    if (e.key.toLowerCase() === "s") { e.preventDefault(); window.setTransformMode("scale"); }
    // R veya O: Orbit modu — NOT: "Döndür" (nesneyi döndürme) aracının eski
    // R kısayolu, resmi CAD-standart şemada R/O'nun Orbit'e ayrılması
    // gerektiği için KALDIRILDI; nesne döndürme aracı hâlâ araç çubuğundaki
    // 🔃 butonundan erişilebilir.
    if (e.key.toLowerCase() === "r" || e.key.toLowerCase() === "o") { e.preventDefault(); window.setTransformMode("orbit"); }
    // H: Pan modu (kaydırma).
    if (e.key.toLowerCase() === "h") { e.preventDefault(); window.setTransformMode("pan"); }
    // D: Üstüne Oturt / Zemine Düşür (Drop) — Tinkercad tarzı hızlı yerleştirme.
    if (e.key.toLowerCase() === "d") { e.preventDefault(); window.dropSelectedToSurface(); }
    // C: Merkeze Al (X/Z orijin + zemine oturt).
    if (e.key.toLowerCase() === "c") { e.preventDefault(); window.centerSelectedToOrigin(); }
    // K: Katı ⇄ Delik (Kesici) geçişi.
    if (e.key.toLowerCase() === "k") { e.preventDefault(); window.toggleHoleSelected(); }
    // L: Kilitle / Kilidi Aç — V: Gizle / Göster (Faz 7, Fusion360 tarzı).
    if (e.key.toLowerCase() === "l") { e.preventDefault(); window.toggleLockSelected(); }
    if (e.key.toLowerCase() === "v") { e.preventDefault(); window.toggleVisibilitySelected(); }
    // M: Manyetik Yüzey Kenetlenmesi aç/kapat (Faz 8).
    if (e.key.toLowerCase() === "m") { e.preventDefault(); window.toggleMagneticSnap(); }
    // ? : Yardım/Kısayollar modalını aç (Faz 7).
    if (e.key === "?") { e.preventDefault(); window.toggleHelpModal(); }
    // \ : sol paneli gizle/göster — daha geniş viewport için hızlı kısayol.
    if (e.key === "\\") { e.preventDefault(); window.toggleSidebar && window.toggleSidebar(); }
});

// ═══════════════════════════════════════════════════════════════
// 3. GEÇMİŞ (UNDO / REDO) — Komut Deseni
// ═══════════════════════════════════════════════════════════════

const history = { stack: [], pointer: -1 };

// NOT: execute/undo/redo async — metin (text) şekilleri font yüklemesi
// gerektirdiği için do()/undo() bir Promise döndürebilir. Sayısal şekillerde
// (box/cylinder/sphere) do()/undo() sıradan senkron fonksiyon kalabilir;
// `await` bunlarda da sorunsuz çalışır (senkron değeri anında çözer).
async function execute(cmd) {
    await cmd.do();
    history.stack = history.stack.slice(0, history.pointer + 1);
    history.stack.push(cmd);
    history.pointer++;
    refreshUndoRedoButtons();
}

window.undo = async function () {
    if (history.pointer < 0) return;
    await history.stack[history.pointer].undo();
    history.pointer--;
    refreshUndoRedoButtons();
    recompute();
    renderOutliner();
    renderInspector();
};

window.redo = async function () {
    if (history.pointer >= history.stack.length - 1) return;
    history.pointer++;
    await history.stack[history.pointer].do();
    refreshUndoRedoButtons();
    recompute();
    renderOutliner();
    renderInspector();
};

function refreshUndoRedoButtons() {
    document.getElementById("btn-undo").disabled = history.pointer < 0;
    document.getElementById("btn-redo").disabled = history.pointer >= history.stack.length - 1;
}

// ═══════════════════════════════════════════════════════════════
// 4. BRUSH (ŞEKİL) OLUŞTURMA VE PARAMETRİK GÜNCELLEME
// ═══════════════════════════════════════════════════════════════

let idCounter = 0;
let selected = null;
let multiSelected = []; // çerçeveyle (marquee) seçilen birden fazla Brush; tekil tıklamada boşalır

// Aktif seçimi (çoklu varsa hepsi, yoksa tekil) düz bir dizi olarak döndürür.
function activeSelectionList() {
    if (multiSelected.length > 0) return multiSelected;
    return selected ? [selected] : [];
}

const DEFAULT_PARAMS = {
    box: { width: 30, height: 15, depth: 30 },
    cylinder: { radius: 15, height: 15 },
    sphere: { radius: 15 },
    text: { value: "OZI", size: 8, depth: 2, font: "roboto_bold", maxWidth: 0 }, // maxWidth (mm): 0 = sınırsız / otomatik sığdırma kapalı
    cone: { radius: 15, height: 25 },
    pyramid: { radius: 15, height: 25 },
    triprism: { radius: 15, height: 20 },
    hexprism: { radius: 15, height: 20 },
    torus: { radius: 15, tube: 5 },
    tube: { outerRadius: 15, innerRadius: 10, height: 15 },
    dome: { radius: 15 },
    icosahedron: { radius: 15 },
    star: { radius: 15, depth: 4 },
    heart: { size: 20, depth: 4 },
    roundedbox: { width: 30, height: 15, depth: 30, radius: 3 },
};
// Renk (Faz 5): TÜM şekil tiplerine ortak bir "color" alanı ekleniyor.
// Bilerek literal içine değil, tek bir döngüyle sonradan ekleniyor — 15
// girdiyi tek tek "color: DEFAULT_SHAPE_COLOR" ile kirletmemek için.
Object.values(DEFAULT_PARAMS).forEach((p) => { p.color = DEFAULT_SHAPE_COLOR; });
// Snapmaker U1 (IDEX) kafa ataması — 1 veya 2. 3MF dışa aktarımında her extruder
// için ayrı <object> üretilir (bkz. build3MFModelXML). Inspector'da "Boyutlar"
// listesinde gösterilmez, "Görünüm" alanındaki Kafa seçicisinden düzenlenir.
Object.values(DEFAULT_PARAMS).forEach((p) => { p.extruder = 1; });

// 3D Metin için Yazı Tipi Kütüphanesi (Faz 5 — canlı font değişimi).
// Üçünün de three.js'in resmi örnek fontları olduğu (aynı CDN/etiket ile
// zaten kullanılan helvetiker_bold gibi) doğrulandı — CORS/versiyon riski yok.
const FONT_LIBRARY = {
    // Türkçe karakterli (ç ğ ı İ ö ş ü) yerel font — fonts/roboto_bold.typeface.json
    // dosyası siteye ayrıca yüklenir. Dosya henüz yoksa loadFont() otomatik olarak
    // helvetiker_bold'a düşer (metin yine oluşur, sadece Türkçe harfler ASCII'ye çevrilir).
    roboto_bold: { label: "Roboto (Türkçe)", url: "../fonts/roboto_bold.typeface.json" },
    helvetiker_bold: { label: "Helvetiker (Kalın)", url: "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r168/examples/fonts/helvetiker_bold.typeface.json" },
    helvetiker_regular: { label: "Helvetiker (İnce)", url: "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r168/examples/fonts/helvetiker_regular.typeface.json" },
    optimer_bold: { label: "Optimer (Kalın)", url: "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r168/examples/fonts/optimer_bold.typeface.json" },
    gentilis_bold: { label: "Gentilis (Kalın)", url: "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r168/examples/fonts/gentilis_bold.typeface.json" },
};

// Türkçe karakterler helvetiker/optimer/gentilis fontlarında yok. Türkçe destekli
// font (roboto_bold) kullanıldığında bu dönüşüm HİÇ uygulanmaz — metin olduğu gibi
// basılır; sadece seçili fontta o harfin glifi YOKSA (bkz. mapUnsupportedGlyphs)
// en yakın Latin karşılığına düşülür.
function turkishToAscii(str) {
    return String(str)
        .replace(/İ/g, "I").replace(/ı/g, "i")
        .replace(/Ş/g, "S").replace(/ş/g, "s")
        .replace(/Ğ/g, "G").replace(/ğ/g, "g")
        .replace(/Ü/g, "U").replace(/ü/g, "u")
        .replace(/Ö/g, "O").replace(/ö/g, "o")
        .replace(/Ç/g, "C").replace(/ç/g, "c");
}

// Her font ailesi kendi Promise'ini önbelleğe alır (fontKey → Promise<Font>) —
// bir kere yüklenen font tekrar ağdan çekilmez, farklı fontlar birbirini
// ezmez (eski sürümde TEK bir paylaşımlı `fontPromise` vardı, yani font
// değiştirme özelliği mimari olarak imkansızdı).
const fontPromises = {};
function loadFont(fontKey) {
    const key = FONT_LIBRARY[fontKey] ? fontKey : "helvetiker_bold";
    if (!fontPromises[key]) {
        fontPromises[key] = new Promise((resolve, reject) => {
            new FontLoader().load(FONT_LIBRARY[key].url, resolve, undefined, reject);
        }).catch((err) => {
            // Başarısız yükleme önbelleğe YAPIŞMASIN (dosya sonradan yüklenince
            // sayfa yenilemeden çalışsın) ve metin oluşturma tamamen çökmesin.
            delete fontPromises[key];
            if (key === "helvetiker_bold") throw err;
            console.warn(`Font yüklenemedi (${FONT_LIBRARY[key].url}) — helvetiker_bold'a düşülüyor:`, err);
            return loadFont("helvetiker_bold");
        });
    }
    return fontPromises[key];
}

// Seçili fontta glifi olmayan karakterleri (ör. helvetiker'da Ş/ğ/İ) en yakın Latin
// karşılığına çevirir; glifi OLAN her karakter (Türkçe destekli fontta tüm Türkçe
// harfler) olduğu gibi bırakılır. `font.data.glyphs`: karakter → glif tablosu.
function mapUnsupportedGlyphs(str, font) {
    const glyphs = font && font.data && font.data.glyphs;
    if (!glyphs) return str;
    return Array.from(str).map((ch) => {
        if (glyphs[ch]) return ch;
        const ascii = turkishToAscii(ch);
        return glyphs[ascii] ? ascii : ch;
    }).join("");
}

// Klasik 5 köşeli yıldız — kalem-yolu (Path) olarak, sonra extrude edilecek.
function buildStarShape(outerR, innerR, points = 5) {
    const shape = new THREE.Shape();
    const step = Math.PI / points;
    for (let i = 0; i < points * 2; i++) {
        const r = i % 2 === 0 ? outerR : innerR;
        const a = i * step - Math.PI / 2;
        const x = Math.cos(a) * r, y = Math.sin(a) * r;
        if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    }
    shape.closePath();
    return shape;
}

// Klasik bezier-kalp yolu (three.js'in kendi "shapes" örneğindeki referans
// koordinatlarla aynı aile) — ~22x19 birimlik bir kutuya sığıyor, sonradan
// `size` parametresine göre ölçekleniyor.
function buildHeartShape() {
    const shape = new THREE.Shape();
    const x = 0, y = 0;
    shape.moveTo(x + 5, y + 5);
    shape.bezierCurveTo(x + 5, y + 5, x + 4, y, x, y);
    shape.bezierCurveTo(x - 6, y, x - 6, y + 7, x - 6, y + 7);
    shape.bezierCurveTo(x - 6, y + 11, x - 3, y + 15.4, x + 5, y + 19);
    shape.bezierCurveTo(x + 12, y + 15.4, x + 16, y + 11, x + 16, y + 7);
    shape.bezierCurveTo(x + 16, y + 7, x + 16, y, x + 10, y);
    shape.bezierCurveTo(x + 7, y, x + 5, y + 5, x + 5, y + 5);
    return shape;
}

// Düz (2D) bir extrude geometrisini merkeze al ve yatay yatır (metin/SVG'de
// kullandığımız aynı kalıp) — yıldız/kalp için ortak.
function flattenAndCenter(geo) {
    geo.rotateX(-Math.PI / 2);
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    geo.translate(-(bb.max.x + bb.min.x) / 2, 0, -(bb.max.z + bb.min.z) / 2);
    return geo;
}

// Eğrisel primitiflerin segment sayıları (Faz 5 — CSG DONMA RİSKİ AZALTMA).
// GERÇEK OLAY: Bu oturumda küre+metin ikilisini birleştirirken tarayıcı
// sekmesi 5+ dakika TAMAMEN KİLİTLENDİ (navigasyon bile 300s'de zaman aşımına
// uğradı) — three-bvh-csg'nin üçgen-bölme (triangle-splitting) algoritması
// yoğun eğrisel/kavisli mesh'lerde ÜSTEL olarak yavaşlıyor (daha önce sadece
// lityofan için dokümante edilmişti, aslında küre/simit/metin gibi HER eğrisel
// şekil için geçerli bir risk). Mimariyi (flat-list/recompute) DEĞİŞTİRMEDEN,
// en düşük riskli önlem: varsayılan segment sayılarını (görsel kaliteyi 3D
// baskıda fark edilmeyecek ölçüde azaltıp) makul seviyede tutmak — bu, CSG
// üçgen-bölme yükünü kabaca YARIYA indiriyor, donma riskini ORTADAN
// KALDIRMASA da BELİRGİN ÖLÇÜDE azaltıyor. İkinci önlem: recompute()'ta
// karmaşık sahnelerde kullanıcıyı ÖNCEDEN uyaran bir mekanizma (bkz. aşağı).
// Faz 12 DÜZELTME: textCurve eskiden 4'tü — TextGeometry'de her harf başına
// harcanan eğri segmenti sayısı, uzun metinlerde toplam üçgen sayısını
// 5000'lere çıkarıp CSG evaluate()'in saniyelerce ana iş parçacığını
// kilitlemesine yol açıyordu. 2'ye çekildi (harfler hâlâ tanınabilir kalır,
// üçgen sayısı kabaca yarıya iner).
const SEG = { cylinder: 32, sphereW: 24, sphereH: 16, cone: 24, torusR: 16, torusT: 32, domeW: 24, domeH: 12, textCurve: 2 };

function buildGeometry(type, params) {
    switch (type) {
        case "box": return new THREE.BoxGeometry(params.width, params.height, params.depth);
        case "cylinder": return new THREE.CylinderGeometry(params.radius, params.radius, params.height, SEG.cylinder);
        case "sphere": return new THREE.SphereGeometry(params.radius, SEG.sphereW, SEG.sphereH);
        case "cone": return new THREE.ConeGeometry(params.radius, params.height, SEG.cone);
        case "pyramid": return new THREE.ConeGeometry(params.radius, params.height, 4).rotateY(Math.PI / 4);
        case "triprism": return new THREE.CylinderGeometry(params.radius, params.radius, params.height, 3);
        case "hexprism": return new THREE.CylinderGeometry(params.radius, params.radius, params.height, 6);
        case "icosahedron": return new THREE.IcosahedronGeometry(params.radius, 0);
        case "roundedbox": {
            // Gerçek "fillet" (BRep kenar yuvarlatma) yerine — bizim CSG
            // motorumuz bunu desteklemiyor — hazır yuvarlatılmış bir birincil
            // şekil sunuyoruz. Yarıçap en küçük kenarın yarısını aşarsa
            // RoundedBoxGeometry görsel bozulma üretir; güvenli üst sınıra kırpıyoruz.
            const maxR = Math.min(params.width, params.height, params.depth) / 2 - 0.1;
            const r = Math.max(0.1, Math.min(params.radius, maxR));
            return new RoundedBoxGeometry(params.width, params.height, params.depth, 4, r);
        }
        case "dome": {
            // Üst yarım küre + düz taban kapağı (kapaksız yarım küre CSG için
            // geçersiz — açık/delikli mesh olur). mergeGeometries zaten import'lu.
            const hemi = new THREE.SphereGeometry(params.radius, SEG.domeW, SEG.domeH, 0, Math.PI * 2, 0, Math.PI / 2);
            const cap = new THREE.CircleGeometry(params.radius, SEG.domeW).rotateX(Math.PI / 2);
            return mergeGeometries([hemi, cap], false);
        }
        case "torus": {
            const geo = new THREE.TorusGeometry(params.radius, params.tube, SEG.torusR, SEG.torusT);
            geo.rotateX(Math.PI / 2); // düz yatsın (halkanın deliği yukarı baksın)
            return geo;
        }
        case "tube": {
            // Dış silindir - iç silindir: gerçek CSG ile TEK SEFERLİK "pişirilir"
            // (evaluator zaten modül seviyesinde mevcut) — sonuç tek bir düz
            // geometri, sahnedeki diğer CSG işlemlerinden bağımsız.
            const outer = new Brush(new THREE.CylinderGeometry(params.outerRadius, params.outerRadius, params.height, SEG.cylinder));
            outer.updateMatrixWorld();
            const inner = new Brush(new THREE.CylinderGeometry(params.innerRadius, params.innerRadius, params.height + 2, SEG.cylinder));
            inner.updateMatrixWorld();
            const result = evaluator.evaluate(outer, inner, SUBTRACTION);
            outer.geometry.dispose(); inner.geometry.dispose();
            return result.geometry;
        }
        case "star": return flattenAndCenter(new THREE.ExtrudeGeometry(buildStarShape(params.radius, params.radius * 0.45), { depth: params.depth, bevelEnabled: false }));
        case "heart": {
            const geo = new THREE.ExtrudeGeometry(buildHeartShape(), { depth: params.depth, bevelEnabled: false });
            geo.scale(params.size / 22, params.size / 22, 1);
            return flattenAndCenter(geo);
        }
        default: return new THREE.BoxGeometry(10, 10, 10);
    }
}

async function buildGeometryAsync(type, params) {
    if (type !== "text") return buildGeometry(type, params);

    const font = await loadFont(params.font);
    // Türkçe karakterler ARTIK ASCII'ye çevrilmiyor — sadece seçili fontta glifi
    // olmayan harfler (ör. font dosyası henüz yüklenmediği için helvetiker'a düşüldüyse)
    // en yakın Latin karşılığına iner.
    const text = mapUnsupportedGlyphs((params.value || "OZI").slice(0, 40), font) || "OZI";
    const geo = new TextGeometry(text, {
        font,
        size: params.size,
        depth: params.depth,
        curveSegments: SEG.textCurve, // bkz. SEG sabitleri — CSG donma riski azaltma
        bevelEnabled: false,
    });
    geo.rotateX(-Math.PI / 2); // düz yatay yüzeyde kabartma gibi dursun (derinlik = Y ekseni)
    geo.computeBoundingBox();
    let bb = geo.boundingBox;

    // Otomatik Sığdırma ("Maks Genişlik", mm): yazı bu genişliği aşarsa SADECE X
    // ekseninde orantılı daraltılır (Y/Z sabit — harf yüksekliği/kalınlığı değişmez).
    // Daraltma brush.scale.x yerine GEOMETRİYE uygulanır: böylece kullanıcının elle
    // yaptığı ölçek (S aracı) ve aynalama (negatif scale.x) ezilmez, ve metin/font
    // değişince sığdırma her yeniden üretimde otomatik yeniden hesaplanır.
    const maxWidth = Number(params.maxWidth) || 0;
    const naturalWidth = bb.max.x - bb.min.x;
    if (maxWidth > 0 && naturalWidth > maxWidth) {
        geo.scale(maxWidth / naturalWidth, 1, 1);
        geo.computeBoundingBox();
        bb = geo.boundingBox;
    }

    geo.translate(-(bb.max.x + bb.min.x) / 2, 0, -(bb.max.z + bb.min.z) / 2);
    return geo;
}

async function createBrush(type, params, name) {
    const geo = await buildGeometryAsync(type, params);
    const color = isValidHexColor(params.color) ? params.color : DEFAULT_SHAPE_COLOR;
    // Faz 5: PREVIEW_MATERIAL'ı klonlamak yerine KENDİ rengiyle AYRI bir
    // materyal örneği kuruyoruz — her brush kendi rengini taşır, evaluate()
    // bunu (useGroups varsayılanı sayesinde) geometri grupları + materyal
    // dizisi olarak korur (bkz. recompute()).
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.1 });
    // Extruder (1/2) materyalin userData'sında da tutulur: CSG sonucundaki materyal
    // dizisi bu örnekleri koruduğu için 3MF dışa aktarımı hangi üçgenin hangi kafaya
    // ait olduğunu materyalden okuyabilir (bkz. build3MFModelXML).
    const extruder = Number(params.extruder) === 2 ? 2 : 1;
    material.userData.extruder = extruder;
    // Inlay dolgusu, oyuk açan orijinalle (SUBTRACTION) BİREBİR aynı yüzeylere sahip;
    // düzenleme görünümünde (csgRoot ham parçalar) ikisi aynı derinlikte çizilip
    // titreşirdi (Z-fighting). Dolgu materyaline hafif negatif polygonOffset vererek
    // dolgunun her zaman öne çıkmasını sağlıyoruz. createBrush her yolun (ekleme,
    // çoğaltma, yapıştırma, kayıttan yükleme) ortak noktası olduğu için bayrak
    // bunların hepsinde otomatik korunur.
    if (params.inlay === true) {
        material.polygonOffset = true;
        material.polygonOffsetFactor = -1;
        material.polygonOffsetUnits = -1;
    }
    const brush = new Brush(geo, material);
    brush.name = name || `${labelFor(type)} ${++idCounter}`;
    brush.operation = ADDITION;
    brush.userData = { id: `node_${idCounter}`, type, params: { ...params, color, extruder } };
    const halfHeightTypes = ["box", "cylinder", "cone", "pyramid", "triprism", "hexprism", "tube", "roundedbox"];
    if (halfHeightTypes.includes(type)) brush.position.y = params.height / 2;
    else if (type === "sphere" || type === "icosahedron") brush.position.y = params.radius;
    else if (type === "torus") brush.position.y = params.tube;
    // dome/star/heart/text: geometrileri zaten y=0 tabanlı kuruluyor, ofset gerekmez.
    brush.updateMatrixWorld();
    return brush;
}

function labelFor(type) {
    return {
        box: "Küp", cylinder: "Silindir", sphere: "Küre", text: "Metin",
        cone: "Koni", pyramid: "Piramit", triprism: "Üçgen Prizma", hexprism: "Altıgen Prizma",
        torus: "Simit", tube: "Tüp/Halka", dome: "Kubbe", icosahedron: "İkosahedron",
        star: "Yıldız", heart: "Kalp", roundedbox: "Yuvarlak Köşeli Küp",
        "stl-import": "STL", "svg-import": "SVG", "photo-relief": "Fotoğraf Kabartma",
    }[type] || "Şekil";
}

// STL/SVG/Fotoğraf gibi ham mesh verisi taşıyan, sayısal parametreleri
// olmayan (dolayısıyla Inspector'da yeniden üretilemeyen/kaydedilemeyen) tipler.
function isNonParametricType(type) {
    return type === "stl-import" || type === "svg-import" || type === "photo-relief";
}

async function regenerateGeometry(brush) {
    const oldGeo = brush.geometry;
    brush.geometry = await buildGeometryAsync(brush.userData.type, brush.userData.params);
    oldGeo.dispose();
    brush.updateMatrixWorld();
}

// Hızlı Yazım: Inspector'daki "Metin" kutusuna odaklanıp içeriği seçer — kullanıcı
// fareyle tekrar tıklamadan doğrudan yeni yazıyı (ör. ismi) yazmaya başlayabilir.
// Kutu yoksa (metin olmayan nesne / çoklu seçim) sessizce hiçbir şey yapmaz.
function focusInspectorTextInput() {
    const input = document.querySelector('#inspector-body input[data-param="value"]');
    if (!input) return;
    input.focus();
    input.select();
}

// ── Hızlı Metin Düzenleme (Faz 8) ────────────────────────────────────────
// Viewport'ta bir CAD.text objesine çift tıklandığında (bkz. pointerup)
// açılan hafif HTML popover — kullanıcıyı her seferinde Inspector paneline
// gitmeye zorlamadan yazıyı değiştirmesini sağlar. Enter = kaydet (undo'lu),
// Escape/dışarı tıklama = vazgeç. `committed` bayrağı Enter+blur'un AYNI
// değişikliği İKİ KEZ execute() yığınına atmasını (çift undo adımı) engeller.
function closeQuickTextEdit() {
    document.getElementById("quick-text-edit")?.remove();
}

function openQuickTextEdit(brush, e) {
    closeQuickTextEdit();
    const container = document.getElementById("canvas-container");
    const rect = container.getBoundingClientRect();
    const wrap = document.createElement("div");
    wrap.id = "quick-text-edit";
    wrap.className = "quick-text-edit";
    wrap.style.left = `${e.clientX - rect.left}px`;
    wrap.style.top = `${e.clientY - rect.top}px`;
    wrap.innerHTML = `<input type="text" maxlength="40" value="${String(brush.userData.params.value).replace(/"/g, "&quot;")}">`;
    container.appendChild(wrap);
    const input = wrap.querySelector("input");
    input.focus();
    input.select();

    let committed = false;
    const oldVal = brush.userData.params.value;
    async function commit() {
        if (committed) return;
        committed = true;
        const newVal = input.value.trim();
        closeQuickTextEdit();
        if (!newVal || newVal === oldVal) return;
        await execute({
            async do() { brush.userData.params.value = newVal; await regenerateGeometry(brush); },
            async undo() { brush.userData.params.value = oldVal; await regenerateGeometry(brush); },
        });
        recompute();
        renderInspector();
        document.getElementById("status-msg").innerText = "Metin güncellendi.";
    }
    function cancel() {
        if (committed) return;
        committed = true; // blur'un tekrar tetiklenip commit denemesini engelle
        closeQuickTextEdit();
    }

    input.addEventListener("keydown", (ke) => {
        // Uygulamanın genel Q/G/S/Delete gibi tek-harf kısayolları buraya
        // SIZMASIN — kullanıcı popover'da yazı yazarken kısayollar tetiklenmemeli.
        ke.stopPropagation();
        if (ke.key === "Enter") { ke.preventDefault(); commit(); }
        else if (ke.key === "Escape") { ke.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", () => commit());
}

// Renk değişimi geometri gerektirmez — sadece materyalin rengini günceller
// (ucuz, senkron). recompute() sonraki katlamada bu yeni rengi otomatik
// olarak materyal dizisine dahil eder.
function updateBrushColor(brush, hex) {
    if (!isValidHexColor(hex)) return;
    brush.material.color.set(hex);
}

// Şekil Kütüphanesi panelindeki "Katı/Delik" anahtarı — yeni eklenen şekillerin
// varsayılan operasyonunu belirler (Tinkercad'in "hole" varyant şekillerine
// karşılık gelir, ama tek anahtarla tüm palet için geçerli — palet ikisini
// ayrı ayrı çoğaltmak yerine).
let newShapeOperation = ADDITION;
window.setNewShapeOperation = function (op) {
    newShapeOperation = op === "hole" ? SUBTRACTION : ADDITION;
    document.querySelectorAll("[data-new-shape-op]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.newShapeOp === op);
    });
};

window.addPrimitive = async function (type) {
    const params = { ...DEFAULT_PARAMS[type] };
    // Metin: varsayılan "OZI" ile sessizce eklemek yerine yazıyı HEMEN sor —
    // kullanıcı Inspector'da "Metin" alanını arayıp bulmak zorunda kalmasın.
    if (type === "text") {
        const value = prompt("Yazılacak metin:", params.value);
        if (value === null) return; // vazgeçildi
        params.value = value.trim() || params.value;
    }
    const brush = await createBrush(type, params);
    brush.operation = newShapeOperation;

    await execute({
        do() { csgRoot.add(brush); },
        undo() { csgRoot.remove(brush); },
    });

    selectNode(brush);
    recompute();
    renderOutliner();
    document.getElementById("status-msg").innerText = `${brush.name} eklendi.`;
    if (type === "text") focusInspectorTextInput();
};

window.deleteSelected = async function () {
    const list = activeSelectionList();
    if (list.length === 0) return;
    // Her brush'ın orijinal indeksini de sakla — undo sırayı korumalı, yoksa
    // Model Ağacı'ndaki (ve dolayısıyla CSG fold sırasındaki) konum kayar.
    const entries = list.map((brush) => ({ brush, parent: brush.parent, index: brush.parent.children.indexOf(brush) }))
        .sort((a, b) => a.index - b.index);

    await execute({
        do() { entries.forEach(({ brush, parent }) => parent.remove(brush)); },
        undo() { entries.forEach(({ brush, parent, index }) => { parent.children.splice(index, 0, brush); brush.parent = parent; }); },
    });

    selectNode(null);
    recompute();
    renderOutliner();
};

// Çoğalt (Ctrl+D) — mevcut createBrush() ile AYNI yoldan yeni bir Brush kurar
// (geometriyi paylaşmaz, kendi kopyasını oluşturur — silme/parametre
// değişikliği ileride birbirini etkilemez). STL/SVG içe aktarımlar için
// geometriyi doğrudan klonlar (onlar buildGeometryAsync üzerinden geçmiyor).
window.duplicateSelected = async function () {
    const list = activeSelectionList();
    if (list.length === 0) return;
    const OFFSET = 10; // mm — kopyanın orijinalin üzerine tam binmemesi için

    const clones = [];
    for (const brush of list) {
        let clone;
        if (isNonParametricType(brush.userData.type)) {
            clone = new Brush(brush.geometry.clone(), brush.material.clone());
            clone.name = `${brush.name} (kopya)`;
            clone.userData = { id: `node_${++idCounter}`, type: brush.userData.type, params: {} };
        } else {
            clone = await createBrush(brush.userData.type, { ...brush.userData.params }, `${brush.name} (kopya)`);
        }
        clone.operation = brush.operation;
        clone.position.set(brush.position.x + OFFSET, brush.position.y, brush.position.z + OFFSET);
        clone.rotation.copy(brush.rotation);
        clone.scale.copy(brush.scale);
        clone.updateMatrixWorld();
        clones.push(clone);
    }

    await execute({
        do() { clones.forEach((c) => csgRoot.add(c)); },
        undo() { clones.forEach((c) => csgRoot.remove(c)); },
    });

    if (clones.length > 1) selectMultiple(clones); else selectNode(clones[0]);
    recompute();
    renderOutliner();
    document.getElementById("status-msg").innerText = `${clones.length} parça çoğaltıldı.`;
};

// ── Kopyala / Yapıştır (Ctrl+C / Ctrl+V) ────────────────────────────────
// Ctrl+D (Çoğalt) ile FARKI: Kopyala bir "pano" (clipboard) durumu tutar —
// bir kez kopyalanan şekil(ler), araya başka işlemler girse bile, istenildiği
// kadar farklı zamanda Yapıştır'a basılarak tekrar eklenebilir. STL/SVG/
// Fotoğraf gibi parametrik olmayan tipler kopyalanamaz (Çoğalt/Kaydet ile
// aynı kısıt — ham mesh verisi düz node formatına sığmıyor).
let clipboard = [];

window.copySelected = function () {
    const list = activeSelectionList().filter((b) => !isNonParametricType(b.userData.type));
    if (list.length === 0) return;
    clipboard = list.map((b) => ({
        type: b.userData.type,
        // params kopyası color/extruder/inlay bayraklarını da taşır (createBrush hepsini
        // korur) — Inlay dolgusu yapıştırılınca yine Inlay + Extruder 2 kalır.
        params: { ...b.userData.params },
        operation: b.operation,
        position: b.position.toArray(),
        rotation: [b.rotation.x, b.rotation.y, b.rotation.z],
        scale: b.scale.toArray(), // S aracı / "0.4mm'ye İncelt" / aynalama (negatif ölçek) korunsun
    }));
    document.getElementById("status-msg").innerText = `${clipboard.length} parça kopyalandı (Ctrl+V ile yapıştırın).`;
};

window.pasteClipboard = async function () {
    if (clipboard.length === 0) return;
    const OFFSET = 10; // mm — yapıştırılan kopyanın orijinalin üzerine tam binmemesi için
    const clones = [];
    for (const entry of clipboard) {
        const clone = await createBrush(entry.type, { ...entry.params }, `${labelFor(entry.type)} (yapıştırıldı)`);
        clone.operation = entry.operation;
        clone.position.set(entry.position[0] + OFFSET, entry.position[1], entry.position[2] + OFFSET);
        clone.rotation.set(entry.rotation[0], entry.rotation[1], entry.rotation[2]);
        if (Array.isArray(entry.scale)) clone.scale.fromArray(entry.scale);
        clone.updateMatrixWorld();
        clones.push(clone);
    }

    await execute({
        do() { clones.forEach((c) => csgRoot.add(c)); },
        undo() { clones.forEach((c) => csgRoot.remove(c)); },
    });

    if (clones.length > 1) selectMultiple(clones); else selectNode(clones[0]);
    recompute();
    renderOutliner();
    document.getElementById("status-msg").innerText = `${clones.length} parça yapıştırıldı.`;
};

// Aynala — seçili şekli/şekilleri KENDİ merkezinde bir eksende ters çevirir
// (negatif ölçek). Çoklu seçimde her parça KENDİ etrafında aynalanır — grubu
// TEK BİR düzlemde aynalamak (göreli konumları da ters çevirmek) ayrı ve daha
// büyük bir iş, bu ilk sürümde kapsam dışı.
window.mirrorSelected = async function (axis) {
    const list = activeSelectionList();
    if (list.length === 0) return;
    const before = list.map((brush) => ({ brush, scale: brush.scale.toArray() }));

    await execute({
        do() { before.forEach(({ brush }) => { brush.scale[axis] *= -1; brush.updateMatrixWorld(); }); },
        undo() { before.forEach(({ brush, scale }) => { brush.scale.fromArray(scale); brush.updateMatrixWorld(); }); },
    });
    recompute();
    renderInspector();
    document.getElementById("status-msg").innerText = `${list.length} parça ${axis.toUpperCase()} ekseninde aynalandı.`;
};

// ── Gelişmiş Hizala (Align 2.0 — Faz 8, Tinkercad stili) ─────────────────
// ESKİ davranış (tek tuş, "ORTAK ORTALAMA konuma" — position.eksen'lerin
// aritmetik ortalaması, boyutları hiç hesaba katmadan) TAMAMEN kaldırıldı.
// YENİ mekanizma: seçili TÜM objelerin BİRLEŞİK Box3'ü (dünya-uzayı AABB)
// hesaplanır; her eksende bu kutunun Min/Orta/Maks değeri "hedef" olur.
// Kullanıcı 9 hedeften birini seçtiğinde, HER obje KENDİ Box3'ünün aynı
// mod'daki (min/center/max) değeri o hedefe denk gelecek şekilde SADECE o
// eksende ötelenir — yani "sol kenarları hizala", "merkezleri hizala", "sağ
// kenarları hizala" gibi standart CAD/tasarım araçları davranışı (boyutları
// hesaba katar, eski "ortalama pozisyon" hack'inden daha doğru).
window.alignSelectedAdvanced = async function (axis, mode) {
    const list = activeSelectionList();
    if (list.length < 2) return;

    csgRoot.children.forEach((c) => c.updateMatrixWorld(true));

    const combined = new THREE.Box3();
    list.forEach((b) => combined.union(new THREE.Box3().setFromObject(b)));
    const targetValue = mode === "min" ? combined.min[axis] : mode === "max" ? combined.max[axis] : (combined.min[axis] + combined.max[axis]) / 2;

    const moves = [];
    list.forEach((brush) => {
        const box = new THREE.Box3().setFromObject(brush);
        const ownValue = mode === "min" ? box.min[axis] : mode === "max" ? box.max[axis] : (box.min[axis] + box.max[axis]) / 2;
        const delta = targetValue - ownValue;
        if (Math.abs(delta) > 0.001) moves.push({ brush, oldPos: brush.position[axis], newPos: brush.position[axis] + delta });
    });
    if (moves.length === 0) return; // zaten hizalı, gereksiz undo adımı yok

    await execute({
        do() { moves.forEach(({ brush, newPos }) => { brush.position[axis] = newPos; brush.updateMatrixWorld(); }); },
        undo() { moves.forEach(({ brush, oldPos }) => { brush.position[axis] = oldPos; brush.updateMatrixWorld(); }); },
    });
    recompute();
    renderInspector();
    const modeLabel = { min: "Min", center: "Orta", max: "Maks" }[mode];
    document.getElementById("status-msg").innerText = `${moves.length} parça ${axis.toUpperCase()} ekseninde ${modeLabel}'a hizalandı.`;
};

// ── Üstüne Oturt / Zemine Düşür (Drop/Stack — Faz 6) ────────────────────
// Tinkercad'deki "bırakınca otursun" hissiyatı: seçili şekli SADECE Y
// ekseninde aşağı kaydırır — tam altında (XZ izdüşümü çakışan) başka bir
// şekil varsa onun TAVANINA (Box3.max.y), yoksa ızgara zeminine (Y=0) oturtur.
// Matematik kısa ve ucuz: her aday için sadece Box3 (dünya-uzayı AABB) alınır,
// XZ dikdörtgen kesişimi + "objenin ŞU ANKİ tabanının AŞAĞISINDA kalma" testi
// yapılır (kayan-nokta payı EPS ile), en yüksek uygun tavan seçilir — asla
// objeyi YUKARI itmez, sadece aşağı indirir.
const DROP_SURFACE_EPS = 0.05; // mm — "temas halinde" sayılacak tolerans
window.dropSelectedToSurface = async function () {
    // NOT: STL/SVG/Fotoğraf gibi içe aktarılan (parametrik olmayan) parçalar
    // da sadece KONUM değiştiği için sorunsuz düşürülebilir — filtre gerekmiyor.
    const list = activeSelectionList();
    if (list.length === 0) return;

    // Box3 hesaplarken TÜM csgRoot çocuklarının güncel matrixWorld'e sahip
    // olduğundan emin ol (drag sonrası/parametre değişikliği sonrası stale
    // olabilir).
    csgRoot.children.forEach((c) => c.updateMatrixWorld(true));

    const moves = [];
    list.forEach((brush) => {
        const box = new THREE.Box3().setFromObject(brush);
        const selfMinY = box.min.y;
        let restY = 0; // zemin varsayılan
        csgRoot.children.forEach((other) => {
            // kendisi, aynı anda düşürülen diğer seçililer VE gizli (yok
            // sayılması gereken) şekiller landing-yüzeyi adayı olamaz.
            if (other === brush || list.includes(other) || !other.visible) return;
            const obox = new THREE.Box3().setFromObject(other);
            const overlapXZ = box.min.x < obox.max.x && box.max.x > obox.min.x && box.min.z < obox.max.z && box.max.z > obox.min.z;
            if (overlapXZ && obox.max.y <= selfMinY + DROP_SURFACE_EPS && obox.max.y > restY) {
                restY = obox.max.y;
            }
        });
        const delta = restY - selfMinY;
        if (Math.abs(delta) > 0.001) moves.push({ brush, delta, oldY: brush.position.y, newY: brush.position.y + delta });
    });

    if (moves.length === 0) {
        document.getElementById("status-msg").innerText = "Zaten yüzeye/zemine oturuyor.";
        return;
    }

    await execute({
        do() { moves.forEach(({ brush, newY }) => { brush.position.y = newY; brush.updateMatrixWorld(); }); },
        undo() { moves.forEach(({ brush, oldY }) => { brush.position.y = oldY; brush.updateMatrixWorld(); }); },
    });
    recompute();
    renderInspector();
    document.getElementById("status-msg").innerText = `${moves.length} parça yüzeye/zemine oturtuldu.`;
};

// ── Merkeze Al / Center to Origin (C) ────────────────────────────────────
// Kaybolan/uzağa giden objeleri sahne merkezine (X=0, Z=0) getirir, sonra
// dropSelectedToSurface() ile zemine indirir. Seçim (tekil ya da çoklu) TEK bir
// grup olarak ele alınır: ORTAK sınır kutusunun merkezi (X,Z) orijine taşınır —
// böylece çoklu seçimde parçalar üst üste yığılmaz, göreli dizilimleri korunur;
// tekil objede (geometriler merkezli kurulduğu için) position.x/z = 0 ile aynı
// sonucu verir, ama döndürülmüş/merkezi kaymış objelerde de GÖRSEL merkezi orijine oturtur.
window.centerSelectedToOrigin = async function () {
    const list = activeSelectionList().filter((b) => !b.userData.locked);
    if (list.length === 0) return;
    csgRoot.children.forEach((c) => c.updateMatrixWorld(true));

    const combined = new THREE.Box3();
    list.forEach((b) => combined.union(new THREE.Box3().setFromObject(b)));
    if (combined.isEmpty()) return;
    const center = combined.getCenter(new THREE.Vector3());
    const dx = -center.x, dz = -center.z;

    if (Math.abs(dx) > 0.001 || Math.abs(dz) > 0.001) {
        const moves = list.map((brush) => ({ brush, oldX: brush.position.x, oldZ: brush.position.z, newX: brush.position.x + dx, newZ: brush.position.z + dz }));
        await execute({
            do() { moves.forEach(({ brush, newX, newZ }) => { brush.position.x = newX; brush.position.z = newZ; brush.updateMatrixWorld(); }); },
            undo() { moves.forEach(({ brush, oldX, oldZ }) => { brush.position.x = oldX; brush.position.z = oldZ; brush.updateMatrixWorld(); }); },
        });
        recompute();
        renderInspector();
    }
    await window.dropSelectedToSurface();
    document.getElementById("status-msg").innerText = `${list.length} parça merkeze alındı ve zemine oturtuldu.`;
};

// ── Yüzüstü Yatır / Lay on Face (F — Orca Slicer tarzı) ─────────────────
// Her seçili şeklin dünya-uzayı sınır kutusuna (Box3) bakar; EN KISA kenar
// hangi eksendeyse onu Y (yukarı) eksenine çevirecek 90°'lik bir dünya
// dönüşü uygular — yani şekil en geniş yüzü zemine gelecek şekilde yatar
// (baskı için en kararlı duruş). Dönüş şeklin KENDİ kutu merkezi etrafında
// yapılır (obje olduğu yerde kalır), ardından mevcut dropSelectedToSurface()
// ile zemine/altındaki yüzeye oturtulur. NOT: kutu dünya-uzayı AABB olduğu
// için rastgele açıyla dönmüş bir şekilde "en kısa kenar" yaklaşık bir tahmindir;
// eksen-hizalı şekillerde ve 90° katlarında tam sonuç verir.
// ── Etkileşimli mod (Orca "Lay on Face") ────────────────────────────────
// F → `layFlatMode`a girilir (imleç artı işaretine döner); kullanıcı objenin bir
// yüzeyine tıklayınca o üçgenin normali (dünya uzayında) alınır, obje o normal
// tam AŞAĞI (0,-1,0) bakacak şekilde döndürülür, dropSelectedToSurface() ile
// zemine oturtulur ve moddan çıkılır. Esc / başka araç seçimi = iptal. Mod
// açıkken F'ye tekrar basmak eski OTOMATİK davranışı (en kısa kenar yukarı) çalıştırır.
function canvasElement() { return document.querySelector("#canvas-container canvas"); }

window.exitLayFlatMode = function (silent) {
    if (!layFlatMode) return false;
    layFlatMode = false;
    const c = canvasElement();
    if (c) c.style.cursor = "";
    if (!silent) document.getElementById("status-msg").innerText = "Yüzüstü yatırma iptal edildi.";
    return true;
};

window.layFlatSelected = function () {
    if (layFlatMode) { window.exitLayFlatMode(true); return window.layFlatAuto(); }
    const list = activeSelectionList().filter((b) => !b.userData.locked);
    if (list.length === 0) {
        document.getElementById("status-msg").innerText = "Yatırmak için önce bir obje seçin (kilitli objeler yatırılamaz).";
        return;
    }
    layFlatMode = true;
    const c = canvasElement();
    if (c) c.style.cursor = "crosshair";
    document.getElementById("status-msg").innerText = "Yüzüstü Yatır: zemine gelecek YÜZEYE tıklayın (Esc: iptal, F: otomatik).";
};

// Verilen dünya-uzayı yüz normali aşağı bakacak şekilde seçimi döndürür + zemine oturtur.
// Çoklu seçimde grup, ORTAK sınır kutusunun merkezi etrafında TEK bir dönüşle çevrilir
// (parçaların göreli konumları bozulmaz).
window.layFlatToWorldNormal = async function (worldNormal) {
    const list = activeSelectionList().filter((b) => !b.userData.locked);
    if (list.length === 0) return;
    csgRoot.children.forEach((c) => c.updateMatrixWorld(true));

    const q = new THREE.Quaternion().setFromUnitVectors(worldNormal.clone().normalize(), new THREE.Vector3(0, -1, 0));
    const alreadyDown = q.angleTo(new THREE.Quaternion()) < 1e-4;

    if (!alreadyDown) {
        const combined = new THREE.Box3();
        list.forEach((b) => combined.union(new THREE.Box3().setFromObject(b)));
        const center = combined.getCenter(new THREE.Vector3());
        const before = list.map((brush) => ({ brush, pos: brush.position.clone(), quat: brush.quaternion.clone() }));
        const after = list.map((brush) => ({
            brush,
            pos: brush.position.clone().sub(center).applyQuaternion(q).add(center),
            quat: brush.quaternion.clone().premultiply(q),
        }));
        await execute({
            do() { after.forEach(({ brush, pos, quat }) => { brush.position.copy(pos); brush.quaternion.copy(quat); brush.updateMatrixWorld(); }); },
            undo() { before.forEach(({ brush, pos, quat }) => { brush.position.copy(pos); brush.quaternion.copy(quat); brush.updateMatrixWorld(); }); },
        });
        recompute();
        renderInspector();
    }
    await window.dropSelectedToSurface();
    document.getElementById("status-msg").innerText = alreadyDown
        ? "Bu yüzey zaten zemine bakıyor."
        : `${list.length} parça seçilen yüzeyi zemine bakacak şekilde yatırıldı.`;
};

// ESKİ otomatik davranış: en kısa kenarı Y'ye çeviren 90°'lik dönüş (F'ye ikinci basış).
const LAY_FLAT_EPS = 0.001; // mm — "boyutlar eşit" sayılacak tolerans
window.layFlatAuto = async function () {
    const list = activeSelectionList().filter((b) => !b.userData.locked);
    if (list.length === 0) return;

    csgRoot.children.forEach((c) => c.updateMatrixWorld(true));

    const before = [];
    const after = [];
    list.forEach((brush) => {
        const box = new THREE.Box3().setFromObject(brush);
        if (box.isEmpty()) return;
        const size = box.getSize(new THREE.Vector3());
        // Y zaten en kısa (veya eşit) ise dönmeye gerek yok.
        const minDim = Math.min(size.x, size.y, size.z);
        if (size.y <= minDim + LAY_FLAT_EPS) return;

        // En kısa kenar X ise Z ekseninde, Z ise X ekseninde 90° çevir → Y'ye gelir.
        const q = new THREE.Quaternion();
        if (size.x <= size.z) q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
        else q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

        const center = box.getCenter(new THREE.Vector3());
        const newQuat = brush.quaternion.clone().premultiply(q);
        const newPos = brush.position.clone().sub(center).applyQuaternion(q).add(center);
        before.push({ brush, pos: brush.position.clone(), quat: brush.quaternion.clone() });
        after.push({ brush, pos: newPos, quat: newQuat });
    });

    if (after.length > 0) {
        await execute({
            do() { after.forEach(({ brush, pos, quat }) => { brush.position.copy(pos); brush.quaternion.copy(quat); brush.updateMatrixWorld(); }); },
            undo() { before.forEach(({ brush, pos, quat }) => { brush.position.copy(pos); brush.quaternion.copy(quat); brush.updateMatrixWorld(); }); },
        });
        recompute();
        renderInspector();
    }
    await window.dropSelectedToSurface();
    document.getElementById("status-msg").innerText = after.length > 0
        ? `${after.length} parça en geniş yüzüne yatırıldı ve zemine oturtuldu.`
        : "Zaten en geniş yüzüne yatıyor.";
};

// ── Katı ⇄ Delik (Kesici) Hızlı Geçişi (K — Tinkercad "hole" mantığı) ───────
// Seçili şekil(ler)i tek tuşla Katı (ADDITION) ile Delik (SUBTRACTION) arasında
// çevirir. Çoklu seçimde TÜMÜ aynı yöne gider: hepsi zaten delikse hepsi katı olur,
// aksi halde hepsi delik olur (karışık seçimde tutarlı sonuç). INTERSECTION
// (Kesişim) durumundaki şekil "katı değil" sayılır ve delik yapılır.
// NOT: 'H' Pan modu olduğu için 'K' (Kesici) kullanılıyor.
window.toggleHoleSelected = async function () {
    const list = activeSelectionList();
    if (list.length === 0) return;
    const allHoles = list.every((b) => b.operation === SUBTRACTION);
    const newOp = allHoles ? ADDITION : SUBTRACTION;
    const before = list.map((brush) => ({ brush, op: brush.operation }));

    await execute({
        do() { before.forEach(({ brush }) => { brush.operation = newOp; }); },
        undo() { before.forEach(({ brush, op }) => { brush.operation = op; }); },
    });
    recompute();
    renderOutliner();
    renderInspector();
    document.getElementById("status-msg").innerText =
        `${list.length} parça ${newOp === SUBTRACTION ? "delik (kesici)" : "katı"} yapıldı.`;
};

// ── Kilitle / Kilidi Aç (L — Faz 7) ──────────────────────────────────────
// Fusion360 tarzı "sabitle": kilitli bir şekle TransformControls ASLA
// bağlanmaz ve fareyle serbest sürükleme de engellenir (bkz. selectNode/
// selectMultiple/setTransformMode ve pointermove'daki drag guard'ları) —
// ama şekil HÂLÂ tıklanıp seçilebilir, Inspector'dan özellikleri okunabilir
// (kullanıcının açıkça istediği davranış). `locked` bilgisi userData'da
// (params DIŞINDA, ayrı bir alanda) tutulur — bu yüzden serializeSceneToNodes/
// AI kaydetme akışına HİÇ karışmaz: kilit durumu bilerek KALICI değil, sadece
// o oturumluk bir düzenleme kolaylığı.
window.toggleLockSelected = async function () {
    const list = activeSelectionList();
    if (list.length === 0) return;
    const newLocked = !list[0].userData.locked;
    const before = list.map((b) => ({ brush: b, was: !!b.userData.locked }));

    await execute({
        do() { before.forEach(({ brush }) => { brush.userData.locked = newLocked; }); },
        undo() { before.forEach(({ brush, was }) => { brush.userData.locked = was; }); },
    });

    // Az önce kilitlenen obje o an gizmo'ya bağlıysa hemen ayır — kilitli bir
    // objeye TransformControls'ün bağlı KALMASI kurala aykırı olurdu.
    if (selected && selected.userData.locked && transformControls.object === selected) {
        transformControls.detach();
    }
    renderOutliner();
    renderInspector();
    document.getElementById("status-msg").innerText = newLocked
        ? `${list.length} parça kilitlendi.`
        : `${list.length} parça kilidi açıldı.`;
};

// ── Gizle / Göster (V — Faz 7) ────────────────────────────────────────────
// TASARIM KARARI (kullanıcı "en stabil olanı seç" dedi): gizlenen şekil CSG
// fold'undan TAMAMEN ÇIKARILIR (bkz. recompute()/estimateSceneTriangles()).
// GEREKÇE: bu mimaride normalde SADECE kaynaşmış `resultMesh` render edilir
// (tek tek çocuklar hep görünmezdir) — yani gizlemenin GÖRSEL bir etkisi
// olması için fold'dan çıkarılması ZORUNLU, aksi halde buton hiçbir şey
// yapmıyormuş gibi görünürdü. Gizli şekiller viewport'ta tıklanamaz (bkz.
// visibleCsgChildren()) ama Model Ağacı'ndan her zaman geri gösterilebilir.
window.toggleVisibilitySelected = async function () {
    const list = activeSelectionList();
    if (list.length === 0) return;
    const newVisible = !list[0].visible;
    const before = list.map((b) => ({ brush: b, was: b.visible }));

    await execute({
        do() { before.forEach(({ brush }) => { brush.visible = newVisible; }); },
        undo() { before.forEach(({ brush, was }) => { brush.visible = was; }); },
    });
    recompute();
    updateSelectionHelper();
    renderOutliner();
    document.getElementById("status-msg").innerText = newVisible
        ? `${list.length} parça gösterildi.`
        : `${list.length} parça gizlendi.`;
};

// Izgaraya Yasla — hem TransformControls ok sürüklemesini (yerleşik
// setTranslationSnap) hem bizim serbest gövde sürüklemesini aynı ızgaraya
// kilitler; her ikisi de TEK bir anahtardan yönetiliyor.
let snapEnabled = false;
const SNAP_SIZE = 5; // mm
window.toggleSnap = function () {
    snapEnabled = !snapEnabled;
    transformControls.setTranslationSnap(snapEnabled ? SNAP_SIZE : null);
    document.getElementById("btn-snap")?.classList.toggle("active", snapEnabled);
    document.getElementById("status-msg").innerText = snapEnabled ? `Izgaraya yaslama açık (${SNAP_SIZE}mm).` : "Izgaraya yaslama kapalı.";
};
function snapValue(v) {
    return snapEnabled ? Math.round(v / SNAP_SIZE) * SNAP_SIZE : v;
}

// ── Manyetik Yüzey Kenetlenmesi (M — Faz 8) ─────────────────────────────
// Izgara-yaslama (yukarıdaki toggleSnap/SNAP_SIZE) SADECE X/Z'yi 5mm'lik
// hücrelere yuvarlar — DÜZ zemine göre çalışır. Bu, TAMAMEN AYRI bir özellik:
// aktifken TransformControls (Taşı modu) ile sürüklenen obje, imlecin ALTINDA
// duran BAŞKA bir cismin YÜZEYİNE (konum + yüzey normaline göre yönelim ile)
// kenetlenir — silindirik/eğik bir yüzeye yazı/logo oturtmak gibi kullanımlar
// için (bkz. transformControls "objectChange" içindeki uygulama).
let magneticSnapEnabled = false;
window.toggleMagneticSnap = function () {
    magneticSnapEnabled = !magneticSnapEnabled;
    document.getElementById("btn-magnetic-snap")?.classList.toggle("active", magneticSnapEnabled);
    document.getElementById("status-msg").innerText = magneticSnapEnabled
        ? "Manyetik yüzey kenetlenmesi açık — Taşı aracıyla sürüklerken altındaki yüzeye oturur."
        : "Manyetik yüzey kenetlenmesi kapalı.";
};

// İçini Boşalt (Shell) — seçili şeklin KENDİ tipinden, orantılı şekilde
// küçültülmüş bir "iç kopyasını" üretip Çıkar (Subtract) olarak ekler.
// Gerçek bir BRep "shell" değil ama dışbükey temel şekiller (küp, silindir,
// küre vb.) için pratikte aynı sonucu verir — motorumuz zaten CSG subtract'i
// destekliyor, bu sadece onu otomatikleştiriyor.
window.shellSelected = async function () {
    const list = activeSelectionList();
    if (list.length === 0) return alert("Önce içini boşaltmak istediğiniz şekli seçin.");
    if (list.some((b) => isNonParametricType(b.userData.type))) {
        return alert("İçe aktarılan STL/SVG/Fotoğraf parçalarında içini boşaltma henüz desteklenmiyor.");
    }

    const input = prompt("Duvar kalınlığı (mm):", "2");
    if (input === null) return;
    const thickness = parseFloat(input);
    if (!Number.isFinite(thickness) || thickness <= 0) return alert("Geçersiz kalınlık girdiniz.");

    const inners = [];
    for (const brush of list) {
        const size = new THREE.Box3().setFromObject(brush).getSize(new THREE.Vector3());
        const shrink = (dim) => Math.max(0.05, (dim - 2 * thickness) / dim);
        const inner = await createBrush(brush.userData.type, { ...brush.userData.params }, `${brush.name} (iç boşluk)`);
        inner.position.copy(brush.position);
        inner.rotation.copy(brush.rotation);
        inner.scale.set(brush.scale.x * shrink(size.x), brush.scale.y * shrink(size.y), brush.scale.z * shrink(size.z));
        inner.operation = SUBTRACTION;
        inner.updateMatrixWorld();
        inners.push(inner);
    }

    await execute({
        do() { inners.forEach((b) => csgRoot.add(b)); },
        undo() { inners.forEach((b) => csgRoot.remove(b)); },
    });
    recompute();
    renderOutliner();
    document.getElementById("status-msg").innerText = `${inners.length} parçanın içi boşaltıldı (duvar: ${thickness}mm).`;
};

// ═══════════════════════════════════════════════════════════════
// 5. CSG DEĞERLENDİRME (RECOMPUTE)
// ═══════════════════════════════════════════════════════════════

// Sahnedeki tüm şekillerin TOPLAM üçgen sayısını (ucuz, sadece geometri
// attribute'larını okuyarak) tahmin eder — GERÇEK CSG çıktısının karmaşıklığı
// değil, ama "bu sahne muhtemelen ağır" uyarısı için yeterince iyi bir proxy.
function estimateSceneTriangles() {
    let total = 0;
    visibleCsgChildren().forEach((c) => {
        const pos = c.geometry.attributes.position;
        if (!pos) return;
        total += (c.geometry.index ? c.geometry.index.count : pos.count) / 3;
    });
    return total;
}

// Faz 9 — RİSK TAHMİNİ İYİLEŞTİRMESİ: sadece üçgen TOPLAMI, bizzat gözlemlenen
// en kötü senaryoyu (birçok eğrisel/kavisli şeklin AYNI noktada ÇAKIŞMASI)
// hafife alıyordu — her şeklin KENDİ üçgen sayısı düşük kalsa bile (ör. 15
// adet ~700 üçgenlik küre), N eğrisel şekil arasındaki OLASI ÇAKIŞAN ÇİFT
// sayısı ~N²/2 olarak KARESEL büyüdüğü için CSG üçgen-bölme maliyeti de
// üstel/karesel patlıyor (bizzat test edilip doğrulandı: 15 çakışan eğrisel
// şekil, TOPLAM üçgen sayısı eşiğin altında kalsa bile dakikalarca kilitlendi).
// Bu yüzden 2+ eğrisel şekil varsa üçgen toplamına KARESEL bir "ceza" ekliyoruz.
const CURVED_SHAPE_TYPES = new Set(["sphere", "cone", "cylinder", "torus", "tube", "dome", "icosahedron", "roundedbox", "text"]);
function estimateSceneRisk() {
    let triangleSum = 0;
    let curvedCount = 0;
    visibleCsgChildren().forEach((c) => {
        const pos = c.geometry.attributes.position;
        if (pos) triangleSum += (c.geometry.index ? c.geometry.index.count : pos.count) / 3;
        if (CURVED_SHAPE_TYPES.has(c.userData.type)) curvedCount++;
    });
    const curvedPenalty = curvedCount >= 2 ? curvedCount * curvedCount * 150 : 0;
    return triangleSum + curvedPenalty;
}

// GERÇEK OLAY (bu oturumda yaşandı): küre + metin gibi eğrisel/kavisli
// şekilleri CSG ile birleştirirken three-bvh-csg'nin üçgen-bölme algoritması
// üstel olarak yavaşlayıp tarayıcı sekmesini DAKİKALARCA kilitleyebiliyor —
// recompute() SENKRON çalıştığı için bu süre boyunca EKRANDA HİÇBİR ŞEY
// (ne uyarı mesajı ne de önceki kare) görünmez. Bu eşiği aşan sahnelerde,
// ağır fold'u BİR SONRAKİ ANİMASYON KARESİNE erteleyip ÖNCE bir uyarı mesajı
// bastırıyoruz — tarayıcı bu mesajı boyayacak fırsatı bulduktan SONRA ağır
// işlem başlıyor. Bu donmayı ORTADAN KALDIRMAZ (tek bir evaluate() çağrısı
// hâlâ kesintisiz sürer) ama kullanıcı en azından NEDEN donduğunu görür ve
// donma riskini SEG sabitleriyle (bkz. buildGeometry) azaltıyoruz.
const HEAVY_SCENE_TRIANGLE_THRESHOLD = 4000;

function recompute() {
    // ÖNEMLİ: sadece GİRDİ şekillerinin üçgen toplamı riski hafife alabilir —
    // CSG boolean işlemi ÇAKIŞAN/kesişen yüzeylerde YENİ üçgenler ürettiği
    // için ÇIKTI, girdi toplamından çok daha büyük olabilir (bizzat
    // gözlemlendi: 5 çakışan küre girdi toplamı ~3600 iken çıktı 7500+'e
    // fırladı). Bir ÖNCEKİ sonucun boyutu, BİR SONRAKİ fold'un başlangıç
    // karmaşıklığının iyi bir göstergesi olduğundan (her adım bir öncekinin
    // SONUCU üzerine inşa edilir), onu da eşik kontrolüne katıyoruz — AYRICA
    // estimateSceneRisk() eğrisel-şekil-sayısına göre karesel bir ceza ekler
    // (bkz. yukarısı) çünkü ÇOK sayıda küçük eğrisel şekil de (tek başına
    // üçgen toplamı düşük kalsa bile) çakışınca aynı derecede tehlikelidir.
    let prevTriCount = 0;
    if (resultMesh) {
        const pos = resultMesh.geometry.attributes.position;
        if (pos) prevTriCount = (resultMesh.geometry.index ? resultMesh.geometry.index.count : pos.count) / 3;
        scene.remove(resultMesh);
        resultMesh.geometry.dispose();
        resultMesh = null;
    }

    // Faz 7 — Gizle/Göster: gizli (visible=false) şekiller CSG fold'una HİÇ
    // katılmaz. GEREKÇE: bu mimaride sahne normalde SADECE kaynaşmış
    // `resultMesh`'i gösterir (tek tek çocuklar her zaman görünmezdir, sadece
    // sürükleme sırasında geçici olarak "patlamış görünüm" için görünür
    // olurlar) — yani "gizleme"nin GÖRSEL olarak herhangi bir etkisi olması
    // için gizlenen şeklin fold'dan ÇIKARILMASI ŞART; aksi halde buton hiçbir
    // şey yapmıyormuş gibi görünürdü.
    const visibleChildren = visibleCsgChildren();
    if (visibleChildren.length === 0) {
        updateHUD();
        updateSelectionHelper();
        return;
    }

    // Faz 12 DÜZELTME (Linear Fold Hatası): eskiden TÜM şekiller kendi
    // `.operation`'larından bağımsız olarak, Outliner'daki KEYFİ diziliş
    // sırasına göre tek bir soldan-sağa zincirde katlanıyordu. Bunun somut
    // sorunu: bir SUBTRACTION yalnızca KENDİSİNDEN ÖNCE zincire girmiş kısmi
    // birleşimi kesiyordu — ondan SONRA eklenen ADDITION'ları hiç
    // etkilemiyordu (kullanıcının doğal beklentisi: bir "delik" her zaman
    // NİHAİ gövdenin tamamını kesmeli). Artık üç ayrı grupta (flat-list
    // mimarisi KORUNARAK — hiyerarşik bir Group ağacına geçilmiyor, sadece
    // fold SIRASI değişiyor): önce TÜM ADDITION'lar kendi aralarında
    // birleştirilip bir "ana gövde" oluşturuluyor, SONRA tüm SUBTRACTION'lar
    // bu gövdeden çıkarılıyor, EN SON tüm INTERSECTION'lar uygulanıyor.
    // "İçine Göm (Inlay)" parçaları (params.inlay) ADDITION olsa da SUBTRACTION'lardan
    // SONRA eklenir: aksi halde ana gövdeyle birleşip kendi oyuğunu açan orijinal
    // (delik) tarafından yeniden kesilirdi ve dolgu parça kaybolurdu.
    const isInlay       = (c) => c.userData && c.userData.params && c.userData.params.inlay === true;
    const additions     = visibleChildren.filter((c) => c.operation === ADDITION && !isInlay(c));
    const subtractions  = visibleChildren.filter((c) => c.operation === SUBTRACTION);
    const inlays        = visibleChildren.filter((c) => c.operation === ADDITION && isInlay(c));
    const intersections = visibleChildren.filter((c) => c.operation === INTERSECTION);
    const orderedGroups  = [additions, subtractions, inlays, intersections];

    // Faz 12 DÜZELTME (CSG Ana İş Parçacığı Kilitlenmesi): eskiden bu katlama
    // TAMAMEN senkron bir forEach idi — TextGeometry gibi yüksek üçgen sayılı
    // şekillerin dahil olduğu tek bir evaluate() çağrısı saniyelerce
    // sürebildiği için tarayıcı "Aw, Snap!" ile çökebiliyordu. `yieldBetweenSteps`
    // true olduğunda (ağır sahne, aşağıda tespit ediliyor) döngü artık for...of
    // + her CSG adımından sonra kısa bir setTimeout molasıyla tarayıcıya nefes
    // aldırıyor. Hafif sahnelerde (yaygın durum) `yieldBetweenSteps=false` ile
    // çağrılıyor — içeride hiçbir `await` tetiklenmediği için fonksiyon (async
    // olsa da) tamamen SENKRON tamamlanır; recompute() sonrası resultMesh'in
    // hemen hazır olmasına güvenen çağıranlar için davranış DEĞİŞMEZ.
    async function performFold(yieldBetweenSteps) {
        try {
            let acc = makeEmptyBrush();
            for (const group of orderedGroups) {
                for (const child of group) {
                    child.updateMatrixWorld(true);
                    const next = evaluator.evaluate(acc, child, child.operation);
                    acc.geometry.dispose();
                    acc = next;
                    if (yieldBetweenSteps) await new Promise((r) => setTimeout(r, 10));
                }
            }
            resultMesh = acc;
            // ARTIK resultMesh.material'i TEK bir PREVIEW_MATERIAL ile EZMİYORUZ —
            // Evaluator (varsayılan useGroups=true) her brush'ın KENDİ materyalini
            // geometri grupları + materyal DİZİSİ olarak zaten koruyor; ezersek
            // per-şekil renk sistemi tamamen devre dışı kalır.
            scene.add(resultMesh);
            // Bir önceki fold BAŞARISIZ olup status-msg'e "CSG hatası..." yazmışsa,
            // bu fold BAŞARILI olduğunda o eski hata mesajı ekranda TAKILI
            // KALMAMALI (kullanıcıyı yanıltır — model aslında düzgün, ama
            // status çubuğu hâlâ hata gösterir). Sadece BU DURUMDA (hata →
            // başarı geçişi) mesajı nötrlüyoruz; addPrimitive/deleteSelected
            // gibi fonksiyonların kendi anlamlı mesajlarını EZMİYORUZ.
            const statusEl = document.getElementById("status-msg");
            if (statusEl.innerText.startsWith("CSG hatası")) statusEl.innerText = "Hazır.";
        } catch (err) {
            console.error("CSG değerlendirme hatası:", err);
            document.getElementById("status-msg").innerText = "CSG hatası: şekiller değerlendirilemedi (konsola bakın).";
        }
        updateHUD();
        updateSelectionHelper();
    }

    const banner = document.getElementById("csg-busy-banner");
    const riskEstimate = Math.max(estimateSceneRisk(), prevTriCount);
    if (visibleChildren.length >= 2 && riskEstimate > HEAVY_SCENE_TRIANGLE_THRESHOLD) {
        // status-msg'e YAZMIYORUZ: recompute()'u çağıran neredeyse her yer
        // (addPrimitive, deleteSelected, drag-end, vb.) kendi status-msg
        // metnini recompute() döndükten HEMEN SONRA yazıyor — bu, status-msg
        // üzerinden verilen bir uyarıyı ekrana hiç boyanmadan ANINDA ezerdi.
        // Bunun yerine status-bar'dan TAMAMEN bağımsız, kendi kendini
        // gizleyen bir viewport banner'ı kullanıyoruz.
        if (banner) banner.style.display = "block";
        // Çift rAF: ilki tarayıcının banner'ı GERÇEKTEN boyamasını garantiler
        // (tek rAF bazen aynı boyama döngüsüne denk gelip banner'ı hiç
        // göstermeden ağır işlemi başlatabilir), ikincisi ağır fold'u çalıştırır.
        requestAnimationFrame(() => requestAnimationFrame(() => {
            performFold(true).finally(() => { if (banner) banner.style.display = "none"; });
        }));
    } else {
        performFold(false);
    }
}

function updateHUD() {
    const hud = document.getElementById("hud-stats");
    if (!resultMesh) {
        hud.innerHTML = "Model: Yüklenmedi<br>Üçgen: 0";
        return;
    }
    const triCount = resultMesh.geometry.index
        ? resultMesh.geometry.index.count / 3
        : resultMesh.geometry.attributes.position.count / 3;
    const box = new THREE.Box3().setFromObject(resultMesh);
    const size = box.getSize(new THREE.Vector3());
    hud.innerHTML = `Model: ${visibleCsgChildren().length} parça<br>Üçgen: ${Math.round(triCount)}<br>Boyut: ${formatLength(size.x)} × ${formatLength(size.y)} × ${formatLength(size.z)}`;
}

// ═══════════════════════════════════════════════════════════════
// 6. SEÇİM, OUTLINER VE INSPECTOR
// ═══════════════════════════════════════════════════════════════

// Tekil seçim (tıklama) — Seç aracında gizmo hiç bağlanmaz (Fusion tarzı:
// önce sadece seç, taşımak için ayrıca "Taşı" aracına geçilmeli).
function selectNode(brush) {
    selected = brush;
    multiSelected = [];
    // Kilitli objeye TransformControls ASLA bağlanmaz (Fusion360 "Kilitle"
    // davranışı) — ama seçim/Inspector okuması hâlâ tamamen serbest.
    if (brush && currentTransformMode !== "select" && !brush.userData.locked) transformControls.attach(brush);
    else transformControls.detach();
    updateSelectionHelper();
    renderOutliner();
    renderInspector();
}

// Çerçeveyle (marquee) çoklu seçim. Gizmo yine de sadece BİRİNCİL (ilk) şekle
// bağlanır — çoklu döndürme/ölçekleme Faz 7'nin ötesinde bir mimari genişleme.
function selectMultiple(brushes) {
    multiSelected = brushes;
    selected = brushes[0] || null;
    if (selected && currentTransformMode !== "select" && !selected.userData.locked) transformControls.attach(selected);
    else transformControls.detach();
    updateSelectionHelper();
    renderOutliner();
    renderInspector();
}

// Shift+tık ile tekil bir şekli aktif çoklu-seçime EKLER veya ondan ÇIKARIR
// (Tinkercad/Fusion360 "toggle-select" kuralı). Mevcut tekil `selected`
// durumu da "1 elemanlı seçim" gibi ele alınır — Outliner/Inspector zaten
// activeSelectionList() üzerinden okuyor, ayrı bir kod yolu gerekmiyor.
function toggleSelection(brush) {
    const current = activeSelectionList();
    const next = current.includes(brush) ? current.filter((b) => b !== brush) : [...current, brush];
    if (next.length === 0) selectNode(null);
    else if (next.length === 1) selectNode(next[0]);
    else selectMultiple(next);
}

function updateSelectionHelper() {
    selectionHelpers.forEach((h) => { scene.remove(h); h.geometry.dispose(); });
    selectionHelpers = [];
    activeSelectionList().forEach((brush) => {
        if (!brush.visible) return; // gizli bir objenin "hayalet" seçim çerçevesi gösterilmez
        const edges = new THREE.EdgesGeometry(brush.geometry);
        const helper = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xfacc15, linewidth: 2 }));
        helper.position.copy(brush.position);
        helper.rotation.copy(brush.rotation);
        helper.scale.copy(brush.scale);
        scene.add(helper);
        selectionHelpers.push(helper);
    });
}

const OP_OPTIONS = [
    { value: ADDITION, label: "Birleştir (Union)" },
    { value: SUBTRACTION, label: "Çıkar (Delik/Oyma)" },
    { value: INTERSECTION, label: "Kesişim" },
];

function renderOutliner() {
    const list = document.getElementById("outliner-list");
    list.innerHTML = "";
    if (csgRoot.children.length === 0) {
        list.innerHTML = `<li class="empty-hint">Henüz şekil eklenmedi. Üstteki araç çubuğundan bir şekil ekleyin.</li>`;
        return;
    }
    const activeList = activeSelectionList();
    csgRoot.children.forEach((brush) => {
        const row = document.createElement("li");
        const isLocked = !!brush.userData.locked;
        const isHidden = brush.visible === false;
        row.className = "outliner-row" + (activeList.includes(brush) ? " selected" : "") + (isHidden ? " row-hidden" : "");
        row.innerHTML = `
            <span class="row-name">${labelFor(brush.userData.type)}: ${brush.name}</span>
            <select data-op>${OP_OPTIONS.map(o => `<option value="${o.value}" ${o.value === brush.operation ? "selected" : ""}>${o.label}</option>`).join("")}</select>
            <button data-lock class="${isLocked ? "is-on" : ""}" title="${isLocked ? "Kilidi Aç" : "Kilitle"} (L)"><i data-lucide="${isLocked ? "lock" : "lock-open"}"></i></button>
            <button data-hide class="${isHidden ? "is-on" : ""}" title="${isHidden ? "Göster" : "Gizle"} (V)"><i data-lucide="${isHidden ? "eye-off" : "eye"}"></i></button>
            <button data-del title="Sil"><i data-lucide="trash-2"></i></button>
        `;
        row.addEventListener("click", (e) => {
            if (e.target.closest("[data-op]") || e.target.closest("[data-del]") || e.target.closest("[data-lock]") || e.target.closest("[data-hide]")) return;
            selectNode(brush);
        });
        row.querySelector("[data-op]").addEventListener("change", async (e) => {
            const oldOp = brush.operation;
            const newOp = parseInt(e.target.value, 10);
            await execute({
                do() { brush.operation = newOp; },
                undo() { brush.operation = oldOp; },
            });
            recompute();
        });
        row.querySelector("[data-lock]").addEventListener("click", () => {
            selectNode(brush);
            window.toggleLockSelected();
        });
        row.querySelector("[data-hide]").addEventListener("click", () => {
            selectNode(brush);
            window.toggleVisibilitySelected();
        });
        row.querySelector("[data-del]").addEventListener("click", () => {
            selectNode(brush);
            window.deleteSelected();
        });
        list.appendChild(row);
    });
    refreshIcons();
}

function renderInspector() {
    const empty = document.getElementById("inspector-empty");
    const body = document.getElementById("inspector-body");
    if (!selected) {
        empty.style.display = "block";
        body.style.display = "none";
        return;
    }
    empty.style.display = "none";
    body.style.display = "flex";
    body.innerHTML = "";

    // Çoğalt/Aynala/İçini Boşalt — tekil VE çoklu seçimde ortak, aynı satır.
    function buildActionsRow() {
        const group = document.createElement("div");
        group.className = "field-group";
        const title = document.createElement("div");
        title.className = "field-group-title";
        title.textContent = "İşlemler";
        group.appendChild(title);

        const row1 = document.createElement("div");
        row1.style.cssText = "display:flex; gap:6px;";
        row1.innerHTML = `
            <button class="btn btn-sm icon-btn-row" style="flex:1; background:var(--bg-surface); border:1px solid var(--border-color);" title="Çoğalt (Ctrl+D)" onclick="window.duplicateSelected()"><i data-lucide="copy-plus"></i> Çoğalt</button>
            <button class="btn btn-sm icon-btn-row" style="flex:1; background:var(--bg-surface); border:1px solid var(--border-color);" title="İçini Boşalt" onclick="window.shellSelected()"><i data-lucide="package-open"></i> Boşalt</button>
        `;
        group.appendChild(row1);

        const rowCenter = document.createElement("div");
        rowCenter.style.cssText = "display:flex; gap:6px;";
        rowCenter.innerHTML = `
            <button class="btn btn-sm icon-btn-row" style="flex:1; background:var(--bg-surface); border:1px solid var(--border-color);" title="Merkeze Al (C) — X/Z orijine getirir ve zemine oturtur" onclick="window.centerSelectedToOrigin()"><i data-lucide="crosshair"></i> Merkeze Al</button>
            <button class="btn btn-sm icon-btn-row" style="flex:1; background:var(--bg-surface); border:1px solid var(--border-color);" title="Yüzüstü Yatır (F) — zemine gelecek yüzeye tıklayın" onclick="window.layFlatSelected()"><i data-lucide="layers"></i> Yüzüstü Yatır</button>
        `;
        group.appendChild(rowCenter);

        const row3 = document.createElement("div");
        row3.style.cssText = "display:flex; gap:6px;";
        row3.innerHTML = `
            <button class="btn btn-sm icon-btn-row" style="flex:1; background:var(--bg-surface); border:1px solid var(--border-color);" title="Sık Kullanılanlara Ekle" onclick="window.addSelectionToFavorites()"><i data-lucide="star"></i> Favorilere Ekle</button>
        `;
        group.appendChild(row3);
        return group;
    }

    // Aynala — "İşlemler"den ayrı, kendi başlığı altında büyük/belirgin butonlar.
    function buildMirrorGroup() {
        const group = document.createElement("div");
        group.className = "field-group";
        const title = document.createElement("div");
        title.className = "field-group-title";
        title.textContent = "Aynala";
        group.appendChild(title);

        const grid = document.createElement("div");
        grid.style.cssText = "display:grid; grid-template-columns:repeat(3, 1fr); gap:8px;";
        const btnStyle = "display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; padding:12px 4px; font-weight:700; font-size:0.85rem; background:var(--bg-surface); border:2px solid var(--accent-primary); color:var(--accent-primary); border-radius:8px; cursor:pointer;";
        [["x", "flip-horizontal", "X Ekseni"], ["y", "flip-vertical", "Y Ekseni"], ["z", "flip-horizontal-2", "Z Ekseni"]].forEach(([axis, icon, label]) => {
            const b = document.createElement("button");
            b.className = "btn";
            b.style.cssText = btnStyle;
            b.title = `${label}nda aynala (ters çevir)`;
            b.innerHTML = `<i data-lucide="${icon}" style="width:22px; height:22px;"></i><span>${label}</span>`;
            b.onclick = () => window.mirrorSelected(axis);
            grid.appendChild(b);
        });
        group.appendChild(grid);
        return group;
    }

    // Çerçeveyle birden fazla şekil seçildiyse: tekil parametre/konum
    // düzenlemesi anlamsız (hangi şeklin mi?) — sadece özet + toplu işlemler.
    if (multiSelected.length > 1) {
        const note = document.createElement("div");
        note.style.cssText = "font-size:0.85rem; color:var(--text-secondary); background:var(--bg-surface-2); padding:12px; border-radius:8px; text-align:center;";
        note.innerHTML = `<b>${multiSelected.length} nesne seçili</b><br><span style="font-size:0.75rem; color:var(--text-muted);">Taşımak için "Taşı" aracına geçip herhangi birini sürükleyin.</span>`;
        body.appendChild(note);

        // Align 2.0 — 3 eksen × 3 mod (Min/Orta/Maks) = 9 tıklanabilir hedef.
        // "(veya ekran koordinatlarına izdüşümlü HTML butonları olarak)"
        // seçeneği burada tercih edildi: 3D sahnede yüzen noktalar yerine
        // Inspector'da net etiketli bir ızgara — daha az riskli, daha
        // erişilebilir, aynı Box3 min/center/max mekanizmasını kullanıyor.
        const alignGroup = document.createElement("div");
        alignGroup.className = "field-group";
        alignGroup.innerHTML = `<div class="field-group-title"><span class="icon-btn-row" style="justify-content:flex-start;"><i data-lucide="align-center"></i> Gelişmiş Hizala</span></div>`;
        const alignGrid = document.createElement("div");
        alignGrid.style.cssText = "display:grid; grid-template-columns: auto repeat(3, 1fr); gap:4px; align-items:center; font-size:0.72rem;";
        const modeLabels = [["min", "Min"], ["center", "Orta"], ["max", "Maks"]];
        alignGrid.innerHTML = `<span></span>` + modeLabels.map(([, label]) => `<span style="text-align:center; color:var(--text-muted); font-weight:700;">${label}</span>`).join("") +
            ["x", "y", "z"].map((axis) => `<span style="font-weight:700; color:var(--text-secondary);">${axis.toUpperCase()}</span>` +
                modeLabels.map(([mode]) => `<button class="btn btn-sm" style="padding:5px 2px; background:var(--bg-surface); border:1px solid var(--border-color);" onclick="window.alignSelectedAdvanced('${axis}','${mode}')" title="${axis.toUpperCase()} — ${{min:"Min",center:"Orta",max:"Maks"}[mode]}">●</button>`).join("")
            ).join("");
        alignGroup.appendChild(alignGrid);
        body.appendChild(alignGroup);

        body.appendChild(buildActionsRow());
        body.appendChild(buildMirrorGroup());
        const delBtn = document.createElement("button");
        delBtn.className = "btn btn-sm icon-btn-row";
        delBtn.style.cssText = "background:var(--accent-danger); color:#fff; width:100%;";
        delBtn.innerHTML = `<i data-lucide="trash-2"></i> Hepsini Sil (${multiSelected.length})`;
        delBtn.onclick = () => window.deleteSelected();
        body.appendChild(delBtn);
        refreshIcons();
        return;
    }

    const brush = selected;
    const isImport = isNonParametricType(brush.userData.type);

    if (!isImport) {
        const group = document.createElement("div");
        group.className = "field-group";
        const title = document.createElement("div");
        title.className = "field-group-title";
        title.textContent = "Boyutlar (mm)";
        group.appendChild(title);

        Object.entries(brush.userData.params).forEach(([key, val]) => {
            // color/extruder: ayrı "Görünüm" alanında (bkz. buildColorField); inlay: dahili bayrak.
            if (key === "color" || key === "extruder" || key === "inlay") return;
            const isText = key === "value";
            const isFont = key === "font";
            const isMaxWidth = key === "maxWidth"; // 0 = kapalı → 0 GEÇERLİ bir değer
            const row = document.createElement("div");
            row.className = "field-row";
            if (isFont) {
                row.innerHTML = `<label>${paramLabel(key)}</label><select>${Object.entries(FONT_LIBRARY).map(([k, f]) => `<option value="${k}" ${k === val ? "selected" : ""}>${f.label}</option>`).join("")}</select>`;
            } else if (isMaxWidth) {
                row.innerHTML = `<label>${paramLabel(key)}</label><input type="number" min="0" step="1" value="${val || ""}" placeholder="0 = kapalı" title="Yazı bu genişliği aşarsa sadece X ekseninde daraltılır. Boş/0 = sınırsız.">`;
            } else {
                row.innerHTML = isText
                    ? `<label>${paramLabel(key)}</label><input type="text" maxlength="40" value="${String(val).replace(/"/g, "&quot;")}">`
                    : `<label>${paramLabel(key)}</label><input type="number" min="0.1" step="0.5" value="${val}">`;
            }
            const input = row.querySelector(isFont ? "select" : "input");
            input.dataset.param = key; // focusInspectorTextInput() "value" alanını bununla bulur
            input.addEventListener("change", async () => {
                const oldVal = brush.userData.params[key];
                let newVal;
                if (isFont) newVal = input.value;
                else if (isText) newVal = input.value.trim() || oldVal;
                else if (isMaxWidth) { const n = parseFloat(input.value); newVal = Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 0; }
                else newVal = parseFloat(input.value) || oldVal;
                if (newVal === oldVal) return;
                await execute({
                    async do() { brush.userData.params[key] = newVal; await regenerateGeometry(brush); },
                    async undo() { brush.userData.params[key] = oldVal; await regenerateGeometry(brush); },
                });
                recompute();
                renderInspector();
            });
            group.appendChild(row);
        });

        // Damga / Inlay makroları: 0.4mm'ye incelt + içine göm (çift renk).
        const stampRow = document.createElement("div");
        stampRow.style.cssText = "display:flex; gap:6px; margin-top:6px;";
        const stampBtnStyle = "flex:1; font-size:0.72rem; padding:6px 4px; background:var(--bg-surface); border:1px solid var(--border-color);";
        const thinBtn = document.createElement("button");
        thinBtn.className = "btn btn-sm";
        thinBtn.style.cssText = stampBtnStyle;
        thinBtn.textContent = "0.4mm'ye İncelt";
        thinBtn.title = "Kalınlığı (yüksekliği) 0.4 mm yapar — alt yüzey yerinde kalır (damga / yüzey çizimi için).";
        thinBtn.onclick = () => window.thinSelectedToStamp();
        const inlayBtn = document.createElement("button");
        inlayBtn.className = "btn btn-sm";
        inlayBtn.style.cssText = stampBtnStyle;
        inlayBtn.textContent = "İçine Göm (Inlay)";
        inlayBtn.title = "Ana gövdede bu şeklin birebir oyuğunu açar ve oyuğu 2. kafa (Extruder 2) + zıt renkle dolduran bir kopya ekler. Şekli, gövdenin üst yüzeyine 0.4 mm gömülecek şekilde konumlayın.";
        inlayBtn.onclick = () => window.inlaySelected();
        stampRow.append(thinBtn, inlayBtn);
        group.appendChild(stampRow);
        body.appendChild(group);
    } else {
        const note = document.createElement("div");
        note.style.cssText = "font-size:0.78rem; color:var(--text-muted); background:var(--bg-surface-2); padding:8px; border-radius:6px;";
        note.textContent = "İçe aktarılan modeller sadece taşıma/döndürme/ölçekleme (ve renk) ile düzenlenebilir.";
        body.appendChild(note);
    }

    body.appendChild(buildColorField(brush));

    body.appendChild(buildVec3Field("Konum", brush.position, (axis, val) => {
        const oldVal = brush.position[axis];
        execute({
            do() { brush.position[axis] = val; brush.updateMatrixWorld(); },
            undo() { brush.position[axis] = oldVal; brush.updateMatrixWorld(); },
        });
        recompute();
    }));

    const rotationGroup = buildVec3Field("Döndürme (°)", { x: THREE.MathUtils.radToDeg(brush.rotation.x), y: THREE.MathUtils.radToDeg(brush.rotation.y), z: THREE.MathUtils.radToDeg(brush.rotation.z) }, (axis, val) => {
        const oldVal = THREE.MathUtils.radToDeg(brush.rotation[axis]);
        execute({
            do() { brush.rotation[axis] = THREE.MathUtils.degToRad(val); brush.updateMatrixWorld(); },
            undo() { brush.rotation[axis] = THREE.MathUtils.degToRad(oldVal); brush.updateMatrixWorld(); },
        });
        recompute();
    });
    // Hızlı çevirme: her eksen için -90° / +90° (alandaki değere eklenir).
    const quickRow = document.createElement("div");
    quickRow.className = "vec3-row";
    quickRow.style.marginTop = "4px";
    ["x", "y", "z"].forEach((axis) => {
        const cell = document.createElement("div");
        cell.style.cssText = "display:flex; gap:2px;";
        [-90, 90].forEach((deg) => {
            const b = document.createElement("button");
            b.className = "btn btn-sm";
            b.style.cssText = "flex:1; padding:4px 0; font-size:0.72rem; background:var(--bg-surface); border:1px solid var(--border-color);";
            b.title = `${axis.toUpperCase()} ekseninde ${deg > 0 ? "+" : ""}${deg}° döndür`;
            b.textContent = `${deg > 0 ? "+" : "−"}90°`;
            b.onclick = async () => {
                const oldRad = brush.rotation[axis];
                const newRad = oldRad + THREE.MathUtils.degToRad(deg);
                await execute({
                    do() { brush.rotation[axis] = newRad; brush.updateMatrixWorld(); },
                    undo() { brush.rotation[axis] = oldRad; brush.updateMatrixWorld(); },
                });
                recompute();
                renderInspector();
            };
            cell.appendChild(b);
        });
        quickRow.appendChild(cell);
    });
    rotationGroup.appendChild(quickRow);
    body.appendChild(rotationGroup);

    body.appendChild(buildActionsRow());
    body.appendChild(buildMirrorGroup());
    refreshIcons();
}

function paramLabel(key) {
    return {
        width: "Genişlik", height: "Yükseklik", depth: "Kalınlık/Derinlik", radius: "Yarıçap",
        value: "Metin", size: "Punto/Boyut", tube: "Tüp Kalınlığı",
        outerRadius: "Dış Yarıçap", innerRadius: "İç Yarıçap", font: "Yazı Tipi", color: "Renk",
        maxWidth: "Maks Genişlik (mm)",
    }[key] || key;
}

// ── Damga (0.4 mm) ve Inlay makroları ────────────────────────────────────
// "Kalınlık" = şeklin DİKEY (Y) ölçüsü: yatay duran damga/yazının baskı kalınlığı.
// Extrude tabanlı şekillerde (yazı/yıldız/kalp) `depth`, prizma/silindir gibi
// yükseklik tabanlılarda `height` parametresidir (extrude geometriler Y'ye yatırılmış
// kuruluyor — bkz. buildGeometryAsync). Kalınlık parametresi olmayan şekillerde
// (küre, simit, kubbe...) Y ölçeği kullanılır.
const STAMP_THICKNESS = 0.4; // mm
const STAMP_THICKNESS_PARAM = {
    text: "depth", star: "depth", heart: "depth",
    box: "height", roundedbox: "height", cylinder: "height", cone: "height",
    pyramid: "height", triprism: "height", hexprism: "height", tube: "height",
};

window.thinSelectedToStamp = async function () {
    if (multiSelected.length > 1 || !selected) return;
    const brush = selected;
    const type = brush.userData.type;
    if (isNonParametricType(type)) return;
    if (brush.userData.locked) { document.getElementById("status-msg").innerText = "Kilitli şekil inceltilemez."; return; }

    const param = STAMP_THICKNESS_PARAM[type];
    brush.updateMatrixWorld(true);
    const oldMinY = new THREE.Box3().setFromObject(brush).min.y;
    const oldPos = brush.position.clone();
    const oldScaleY = brush.scale.y;
    const oldParamVal = param ? brush.userData.params[param] : null;

    let newScaleY = oldScaleY;
    if (!param) {
        brush.geometry.computeBoundingBox();
        const geoHeight = brush.geometry.boundingBox.max.y - brush.geometry.boundingBox.min.y;
        if (geoHeight > 0) newScaleY = (STAMP_THICKNESS / geoHeight) * Math.sign(oldScaleY || 1);
    }

    await execute({
        async do() {
            if (param) { brush.userData.params[param] = STAMP_THICKNESS; await regenerateGeometry(brush); }
            else brush.scale.y = newScaleY;
            brush.updateMatrixWorld(true);
            // Alt yüzey yerinde kalsın (havada asılı/gömülü kalmasın).
            brush.position.y += oldMinY - new THREE.Box3().setFromObject(brush).min.y;
            brush.updateMatrixWorld(true);
        },
        async undo() {
            if (param) { brush.userData.params[param] = oldParamVal; await regenerateGeometry(brush); }
            brush.scale.y = oldScaleY;
            brush.position.copy(oldPos);
            brush.updateMatrixWorld(true);
        },
    });
    recompute();
    renderInspector();
    document.getElementById("status-msg").innerText = `${brush.name} ${STAMP_THICKNESS} mm kalınlığa inceltildi.`;
};

// Verilen rengin "dikkat çekici zıt"ı: renkli tonlarda ton +180° (tam zıt renk),
// gri/siyah/beyaz gibi renksiz tonlarda ton anlamsız olduğundan sabit bir kırmızı.
function contrastColor(hex) {
    const c = new THREE.Color(isValidHexColor(hex) ? hex : DEFAULT_SHAPE_COLOR);
    const hsl = {};
    c.getHSL(hsl);
    if (hsl.s < 0.15) return "#e53935";
    c.setHSL((hsl.h + 0.5) % 1, Math.max(hsl.s, 0.75), 0.5);
    return "#" + c.getHexString();
}

// İçine Göm (Inlay): seçili ince şeklin AYNI koordinatlarda bir kopyasını çıkarır;
// orijinal Delik (SUBTRACTION) olup ana gövdede birebir oyuk açar, kopya Katı
// (ADDITION) + zıt renk + Extruder 2 olarak o oyuğu doldurur → yüzey düz kalır.
// Kopyaya `params.inlay = true` işareti konur: recompute() bu tür parçaları
// SUBTRACTION'lardan SONRA ekler (aksi halde kendi oyuğunu açan orijinal tarafından
// yeniden kesilir ve dolgu kaybolurdu). Tek execute() = tek undo adımı.
window.inlaySelected = async function () {
    if (multiSelected.length > 1 || !selected) return;
    const brush = selected;
    if (isNonParametricType(brush.userData.type)) {
        document.getElementById("status-msg").innerText = "İçe aktarılan modellerde Inlay desteklenmez (parametrik şekil gerekir).";
        return;
    }

    const clone = await createBrush(
        brush.userData.type,
        { ...brush.userData.params, color: contrastColor(brush.userData.params.color), extruder: 2, inlay: true },
        `${brush.name} (inlay)`
    );
    clone.operation = ADDITION;
    clone.position.copy(brush.position);
    clone.quaternion.copy(brush.quaternion);
    clone.scale.copy(brush.scale);
    clone.updateMatrixWorld(true);

    const oldOp = brush.operation;
    await execute({
        do() { brush.operation = SUBTRACTION; csgRoot.add(clone); },
        undo() { brush.operation = oldOp; csgRoot.remove(clone); },
    });
    selectNode(clone);
    recompute();
    renderOutliner();
    document.getElementById("status-msg").innerText = `İçine gömüldü: "${brush.name}" oyuk açtı, "${clone.name}" (Extruder 2) dolduruyor.`;
};

// Renk/Materyal alanı (Faz 5) — TÜM şekil tiplerinde (içe aktarılanlar dahil)
// ortak, "Boyutlar" listesinden ayrı tek bir renk seçici. `input` olayı
// (sürüklerken canlı önizleme, undo'suz) ile `change` olayını (bırakınca
// KALICI hale getir, undo'lu) ayrı tutuyoruz — yoksa renk seçiciyi sürüklerken
// her piksel değişiminde ayrı bir undo adımı birikirdi.
function buildColorField(brush) {
    const group = document.createElement("div");
    group.className = "field-group";
    const title = document.createElement("div");
    title.className = "field-group-title";
    title.textContent = "Görünüm";
    group.appendChild(title);

    const row = document.createElement("div");
    row.className = "field-row";
    const startColor = isValidHexColor(brush.userData.params.color) ? brush.userData.params.color : DEFAULT_SHAPE_COLOR;
    row.innerHTML = `<label>Renk</label><input type="color" value="${startColor}">`;
    const input = row.querySelector("input");

    // Son KALICI (undo'ya işlenmiş) renk — palet tıklamaları ve seçici art arda
    // kullanıldığında her adımın doğru "eski" değeri olsun diye izlenir.
    let committedColor = startColor.toLowerCase();

    async function commitColor(newVal) {
        newVal = newVal.toLowerCase();
        const oldVal = committedColor;
        if (oldVal === newVal) return;
        committedColor = newVal;
        input.value = newVal;
        await execute({
            do() { brush.userData.params.color = newVal; updateBrushColor(brush, newVal); },
            undo() { brush.userData.params.color = oldVal; updateBrushColor(brush, oldVal); },
        });
        recompute();
    }

    // Hızlı renk paleti — native renk seçicinin hemen ÜSTÜNDE.
    const QUICK_COLORS = [
        ["Kırmızı", "#e53935"], ["Turuncu", "#fb8c00"], ["Sarı", "#fdd835"], ["Yeşil", "#43a047"],
        ["Mavi", "#1e88e5"], ["Mor", "#8e24aa"], ["Siyah", "#212121"], ["Gri", "#9e9e9e"], ["Beyaz", "#fafafa"],
    ];
    const swatches = document.createElement("div");
    swatches.style.cssText = "display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px;";
    QUICK_COLORS.forEach(([name, hex]) => {
        const s = document.createElement("button");
        s.type = "button";
        s.title = name;
        s.setAttribute("aria-label", name);
        s.style.cssText = `width:22px; height:22px; border-radius:50%; border:2px solid var(--border-color); background:${hex}; cursor:pointer; padding:0; flex:none;`;
        s.addEventListener("click", () => commitColor(hex));
        swatches.appendChild(s);
    });
    group.appendChild(swatches);

    input.addEventListener("input", () => {
        updateBrushColor(brush, input.value);
        recompute();
    });
    input.addEventListener("change", () => commitColor(input.value));
    group.appendChild(row);

    // Snapmaker U1 (IDEX) kafa ataması: "Kafa (Extruder): (•)1 (•)2". Değer
    // params.extruder (1|2) + materyal userData'sında tutulur; 3MF dışa aktarımı
    // her extruder için ayrı <object> üretir (bkz. build3MFModelXML).
    const extruderRow = document.createElement("div");
    extruderRow.className = "field-row";
    extruderRow.style.cssText = "align-items:center; gap:10px;";
    const currentExtruder = Number(brush.userData.params.extruder) === 2 ? 2 : 1;
    const radioName = `extruder-${brush.userData.id}`;
    extruderRow.innerHTML = `<label>Kafa (Extruder)</label>` +
        [1, 2].map((n) => `<label style="display:flex; align-items:center; gap:4px; cursor:pointer; font-weight:600;">` +
            `<input type="radio" name="${radioName}" value="${n}" ${n === currentExtruder ? "checked" : ""} style="width:auto; flex:none; margin:0;"> ${n}</label>`).join("");
    extruderRow.querySelectorAll("input[type=radio]").forEach((radio) => {
        radio.addEventListener("change", async () => {
            const newVal = Number(radio.value);
            const oldVal = Number(brush.userData.params.extruder) === 2 ? 2 : 1;
            if (newVal === oldVal) return;
            await execute({
                do() { brush.userData.params.extruder = newVal; brush.material.userData.extruder = newVal; },
                undo() { brush.userData.params.extruder = oldVal; brush.material.userData.extruder = oldVal; },
            });
            recompute();
            renderInspector();
        });
    });
    group.appendChild(extruderRow);
    return group;
}

function buildVec3Field(title, vec, onChange) {
    const group = document.createElement("div");
    group.className = "field-group";
    const titleEl = document.createElement("div");
    titleEl.className = "field-group-title";
    titleEl.textContent = title;
    group.appendChild(titleEl);

    const row = document.createElement("div");
    row.className = "vec3-row";
    ["x", "y", "z"].forEach((axis) => {
        const input = document.createElement("input");
        input.type = "number";
        input.step = "0.5";
        input.value = Number(vec[axis]).toFixed(2);
        input.addEventListener("change", () => onChange(axis, parseFloat(input.value) || 0));
        row.appendChild(input);
    });
    group.appendChild(row);
    return group;
}

// ═══════════════════════════════════════════════════════════════
// 7. STL / SVG İÇE AKTARMA
// ═══════════════════════════════════════════════════════════════

window.handleSTLImport = function (event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async function (e) {
        let geometry = new STLLoader().parse(e.target.result);

        // STL'de her üçgenin köşeleri ayrı yazılır (komşu yüzler köşe paylaşmaz) ve
        // yüz başına düz normal gelir; bu, CSG'de açık kenar/manifold hatalarına yol
        // açar. Normal niteliğini atıp köşeleri kaynaklayarak (mergeVertices yalnızca
        // TÜM nitelikleri aynı olan köşeleri birleştirir) kapalı bir ağ elde ediyoruz.
        geometry.deleteAttribute("normal");
        geometry = mergeVertices(geometry);
        geometry.computeVertexNormals();

        // STLLoader "uv" üretmez; three-bvh-csg ise CSG için uv niteliğini şart koşar
        // (bkz. makeEmptyBrush() / buildLithophaneGeometry()). Kaynaklamadan SONRA
        // eklenir ki köşe sayısıyla birebir eşleşsin.
        if (!geometry.attributes.uv) {
            const vertexCount = geometry.attributes.position.count;
            geometry.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(vertexCount * 2), 2));
        }

        geometry.computeBoundingBox();
        const bb = geometry.boundingBox;
        geometry.translate(-(bb.max.x + bb.min.x) / 2, -bb.min.y, -(bb.max.z + bb.min.z) / 2);

        const brush = new Brush(geometry, PREVIEW_MATERIAL.clone());
        brush.name = file.name.replace(/\.stl$/i, "");
        brush.operation = ADDITION;
        brush.userData = { id: `node_${++idCounter}`, type: "stl-import", params: {} };
        brush.updateMatrixWorld();

        await execute({ do() { csgRoot.add(brush); }, undo() { csgRoot.remove(brush); } });
        selectNode(brush);
        recompute();
        renderOutliner();
        window.focusSelected();
        document.getElementById("status-msg").innerText = `${brush.name}.stl içe aktarıldı.`;
    };
    reader.readAsArrayBuffer(file);
    event.target.value = "";
};

window.handleSVGImport = function (event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async function (e) {
        const svgData = new SVGLoader().parse(e.target.result);
        const geometries = [];
        svgData.paths.forEach((path) => {
            path.toShapes(true).forEach((shape) => {
                geometries.push(new THREE.ExtrudeGeometry(shape, { depth: 5, bevelEnabled: false }));
            });
        });
        if (geometries.length === 0) {
            alert("SVG içinde çevrilebilir bir vektör şekli bulunamadı.");
            return;
        }
        let merged = geometries.length > 1 ? mergeGeometries(geometries, false) : geometries[0];
        merged.rotateX(Math.PI); // SVG Y-ekseni ters
        merged.computeBoundingBox();
        const bb = merged.boundingBox;
        merged.translate(-(bb.max.x + bb.min.x) / 2, -bb.min.y, -(bb.max.z + bb.min.z) / 2);

        const brush = new Brush(merged, PREVIEW_MATERIAL.clone());
        brush.name = file.name.replace(/\.svg$/i, "");
        brush.operation = ADDITION;
        brush.userData = { id: `node_${++idCounter}`, type: "svg-import", params: {} };
        brush.updateMatrixWorld();

        await execute({ do() { csgRoot.add(brush); }, undo() { csgRoot.remove(brush); } });
        selectNode(brush);
        recompute();
        renderOutliner();
        window.focusSelected();
        document.getElementById("status-msg").innerText = `${brush.name}.svg kabartıldı. Model ağacından "Çıkar" seçerek oyma yapabilirsiniz.`;
    };
    reader.readAsText(file);
    event.target.value = "";
};

// ═══════════════════════════════════════════════════════════════
// 7b. FOTOĞRAFTAN KABARTMA (LİTYOFAN) — istenen görsel-3D özelliği
// ═══════════════════════════════════════════════════════════════
// Gerçek bir "insan yüzünü 3D'ye çevirme" (fotogrametri/3D yüz rekonstrüksiyonu)
// DEĞİL — bu, ayrı bir yapay zeka modeli + muhtemelen sunucu altyapısı isteyen
// çok daha büyük bir problem. Bunun yerine, fuar/anahtarlık/madalyon üretimi
// için gerçekten kullanılan ve TAMAMEN istemci tarafında yapılabilen bir
// teknik uyguluyoruz: fotoğrafın gri tonlama parlaklığını yüksekliğe eşleyip
// (parlak = yüksek kabartma) düz bir taban plakasıyla KAPALI bir katı mesh
// üretmek. CSG (boolean) işlemleri için mesh'in mutlaka kapalı/manifold
// olması gerekiyor — bu yüzden sadece üst yüzeyi değil, alt tabanı ve dört
// yan duvarı da elle örüyoruz.

// Fotoğrafı (segX+1)x(segZ+1) çözünürlüğe indirgeyip gri tonlama (0..1)
// yükseklik ızgarasına çevirir. Tarayıcının kendi <canvas> ölçeklemesi
// downsample işini görüyor (ekstra kütüphane gerekmez).
async function loadImageAsHeightGrid(file, segX, segZ, invert) {
    const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(file);
    });
    const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = dataUrl;
    });

    const w = segX + 1, h = segZ + 1;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;

    const heights = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
        const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
        let v = (0.299 * r + 0.587 * g + 0.114 * b) / 255; // standart gri tonlama ağırlıkları
        if (invert) v = 1 - v;
        heights[i] = v;
    }
    return heights;
}

// Yükseklik ızgarasından KAPALI (üst + alt + 4 yan duvar) bir katı mesh
// örer. İndekssiz (üçgen-yığını) üretiyoruz — sarım/index kitaplığı hatası
// riskini en aza indiren en basit ve en az hataya açık yöntem.
function buildLithophaneGeometry(heights, segX, segZ, width, depth, baseThickness, reliefHeight) {
    const dx = width / segX, dz = depth / segZ;
    const ox = -width / 2, oz = -depth / 2;
    const cols = segX + 1;

    const topY = (i, j) => baseThickness + heights[j * cols + i] * reliefHeight;
    const topPt = (i, j) => [ox + i * dx, topY(i, j), oz + j * dz];
    const botPt = (i, j) => [ox + i * dx, 0, oz + j * dz];

    const pos = [];
    const tri = (a, b, c) => pos.push(...a, ...b, ...c);
    const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); }; // a→b→c→d, saat yönünün tersi = dışa bakan normal

    // Üst yüzey (yukarı bakan normal)
    for (let j = 0; j < segZ; j++) for (let i = 0; i < segX; i++) {
        quad(topPt(i, j), topPt(i + 1, j), topPt(i + 1, j + 1), topPt(i, j + 1));
    }
    // Alt taban (ters sarım → aşağı bakan normal)
    for (let j = 0; j < segZ; j++) for (let i = 0; i < segX; i++) {
        quad(botPt(i, j + 1), botPt(i + 1, j + 1), botPt(i + 1, j), botPt(i, j));
    }
    // Ön kenar (j=0, -Z'ye bakan normal)
    for (let i = 0; i < segX; i++) {
        quad(botPt(i, 0), botPt(i + 1, 0), topPt(i + 1, 0), topPt(i, 0));
    }
    // Arka kenar (j=segZ, +Z'ye bakan normal)
    for (let i = 0; i < segX; i++) {
        quad(topPt(i, segZ), topPt(i + 1, segZ), botPt(i + 1, segZ), botPt(i, segZ));
    }
    // Sol kenar (i=0, -X'e bakan normal)
    for (let j = 0; j < segZ; j++) {
        quad(topPt(0, j), topPt(0, j + 1), botPt(0, j + 1), botPt(0, j));
    }
    // Sağ kenar (i=segX, +X'e bakan normal)
    for (let j = 0; j < segZ; j++) {
        quad(botPt(segX, j), botPt(segX, j + 1), topPt(segX, j + 1), topPt(segX, j));
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    // three-bvh-csg CSG işlemleri için bir "uv" niteliğinin VAR OLMASINI şart
    // koşuyor (gerçek doku eşlemesi önemli değil — düz renk materyalimiz var,
    // bu yüzden hepsi sıfır bir dolgu UV yeterli; bkz. makeEmptyBrush()'taki
    // aynı gereksinim).
    const vertexCount = pos.length / 3;
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(vertexCount * 2), 2));
    geo.computeVertexNormals();
    return geo;
}

// ÖNEMLİ PERFORMANS NOTU (bizzat test edilip doğrulandı): Bu kabartma tek
// başına HER çözünürlükte anında oluşuyor — sorun onu BAŞKA BİR ŞEKİLLE
// (özellikle aynı/yakın konumda, hacimce örtüşerek) birleştirirken çıkıyor.
// 72 VE 48 segmanla bile bir kutuyla birleştirmeyi denediğimde CSG işlemi
// 45 saniyeyi aşıp pratikte kilitlendi — sürekli eğrisel/yüksek-frekanslı
// yüzeyler CSG boolean algoritmaları için bilinen en kötü durumdur. 32'ye
// düşürmek bunu pratikte kullanılabilir kılıyor. Kullanıcıya net tavsiye:
// kabartmayı TEK BAŞINA bir parça olarak kullanın (madalyon/plaket gibi)
// veya SADECE küçük/ince bir "Çıkar" (ör. anahtarlık deliği) ile birleştirin
// — büyük bir gövdeyle TAM HACİMLİ birleştirme (Union) önerilmez.
const LITHOPHANE_RES = 32;

window.handlePhotoImport = async function (event) {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) return alert("Lütfen bir resim dosyası seçin (PNG/JPG).");

    const sizeInput = prompt("Kabartmanın genişliği/derinliği (mm, kare):", "60");
    if (sizeInput === null) return;
    const size = Math.min(200, Math.max(10, parseFloat(sizeInput) || 60));
    const BASE_THICKNESS = 1.5, RELIEF_HEIGHT = 3;

    document.getElementById("status-msg").innerText = "Fotoğraf işleniyor, kabartma üretiliyor...";
    try {
        const heights = await loadImageAsHeightGrid(file, LITHOPHANE_RES, LITHOPHANE_RES, false);
        const geo = buildLithophaneGeometry(heights, LITHOPHANE_RES, LITHOPHANE_RES, size, size, BASE_THICKNESS, RELIEF_HEIGHT);

        const brush = new Brush(geo, PREVIEW_MATERIAL.clone());
        brush.name = file.name.replace(/\.[^.]+$/, "");
        brush.operation = ADDITION;
        brush.userData = { id: `node_${++idCounter}`, type: "photo-relief", params: {} };
        brush.updateMatrixWorld();

        await execute({ do() { csgRoot.add(brush); }, undo() { csgRoot.remove(brush); } });
        selectNode(brush);
        recompute();
        renderOutliner();
        window.focusSelected();
        document.getElementById("status-msg").innerText = `${brush.name} fotoğrafından ${size}mm kabartma üretildi.`;
    } catch (err) {
        console.error("handlePhotoImport:", err);
        alert("Fotoğraf işlenirken hata oluştu: " + err.message);
        document.getElementById("status-msg").innerText = "Fotoğraf kabartma hatası.";
    }
};

// ═══════════════════════════════════════════════════════════════
// 8. SANDBOX'LI AI-CAD MOTORU (Faz 2)
// ═══════════════════════════════════════════════════════════════
//
// GÜVENLİK MODELİ:
//  1) AI'nin ürettiği (veya kullanıcının elle düzenlediği) JS kodu, ana sayfa
//     bağlamında ASLA çalıştırılmaz.
//  2) Kod, `allow-same-origin` OLMADAN `sandbox="allow-scripts"` ile açılmış
//     bir <iframe srcdoc> içinde çalışır. Bu kombinasyon iframe'e opak/
//     benzersiz bir origin verir: ozisg.com'un çerezlerine, localStorage'ına,
//     IndexedDB'sine (→ Firebase Auth oturum belirteçleri) ERİŞEMEZ. Bu iki
//     token'ı BİRLİKTE vermek klasik sandbox-kaçış hatasıdır — asla ekleme.
//  3) Sandbox içindeki "CAD" API'si sadece düz sayısal veri üretir; three.js,
//     WebGL veya DOM'a dokunmaz. Sonuç, postMessage ile TEK SEFERLİK ve
//     `event.source` kimliği doğrulanarak ana sayfaya döner.
//  4) Ana sayfa bu veriye asla güvenmez: validateAndConvertNodes() her tipi
//     whitelist'e, her sayıyı sonlu/aralık sınırlarına karşı süzer. Şüpheli
//     JS token'ı (fetch, document, window, import, vb.) içeren kod sandbox'a
//     gönderilmeden önce reddedilir (ek savunma katmanı).
//  5) Sandbox'ın kendi CSP'si (aşağıdaki meta etiketi) `default-src 'none'`
//     ile ağ erişimini bağımsız olarak da kapatır.
//  6) Sonsuz döngü ihtimaline karşı sabit bir zaman aşımı vardır; süre
//     dolarsa iframe imha edilir, ana sayfa asla kilitlenmez.

const SANDBOX_TIMEOUT_MS = 4000;
const SUSPICIOUS_TOKENS = /\b(fetch|XMLHttpRequest|WebSocket|import|document|window|parent|top|globalThis|self)\b|constructor\s*\.\s*constructor|<\s*script/i;

const SANDBOX_SRCDOC = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval';">
</head><body><script>
(function () {
  "use strict";
  var ALLOWED_TYPES = ["box", "cylinder", "sphere", "text", "cone", "pyramid", "triprism", "hexprism", "torus", "tube", "dome", "icosahedron", "star", "heart", "roundedbox"];
  var CAD = { _nodes: [] };

  function makeNode(type, params) {
    var node = {
      type: ALLOWED_TYPES.indexOf(type) !== -1 ? type : "box",
      params: (params && typeof params === "object") ? params : {},
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      operation: "union"
    };
    CAD._nodes.push(node);
    // İKİ ÇAĞRI ÜSLUBUNU DA DESTEKLER (LLM'ler ikisini de üretiyor, ampirik
    // olarak doğrulandı):
    //   1) CAD.cylinder({...}).subtract()            → kendi node'unu işaretler
    //   2) CAD.box({...}).subtract(CAD.cylinder({...})) → ARGÜMANI işaretler
    // Argüman varsa (bir başka CAD node'u ise) operasyon ONA uygulanır ve
    // çağrılan şeklin kendi operasyonu değişmez — bu, iç içe/zincirleme
    // "ana gövdeden şunu çıkar" yazım tarzını doğru şekilde karşılar.
    function applyOp(opName, other) {
      var target = (other && other.__node) ? other.__node : node;
      target.operation = opName;
      return api;
    }
    var api = {
      __node: node,
      move: function (x, y, z) { node.position = [Number(x) || 0, Number(y) || 0, Number(z) || 0]; return api; },
      rotate: function (x, y, z) { node.rotation = [Number(x) || 0, Number(y) || 0, Number(z) || 0]; return api; },
      union: function (other) { return applyOp("union", other); },
      subtract: function (other) { return applyOp("subtract", other); },
      intersect: function (other) { return applyOp("intersect", other); }
    };
    return api;
  }

  ALLOWED_TYPES.forEach(function (t) {
    CAD[t] = function (params) { return makeNode(t, params); };
  });

  window.addEventListener("message", function (e) {
    CAD._nodes = [];
    var result;
    try {
      var runner = new Function("CAD", String((e.data && e.data.code) || ""));
      runner(CAD);
      result = { ok: true, nodes: CAD._nodes };
    } catch (err) {
      result = { ok: false, error: String((err && err.message) || err) };
    }
    parent.postMessage(result, "*");
  });
})();
<\/script></body></html>`;

function runSandboxed(code) {
    if (SUSPICIOUS_TOKENS.test(code)) {
        return Promise.reject(new Error("Kod izin verilmeyen bir ifade içeriyor (sadece CAD.* çağrılarına izin var)."));
    }

    return new Promise((resolve, reject) => {
        const iframe = document.createElement("iframe");
        // KASITLI: "allow-same-origin" YOK. Bu iframe'i sitenin gerçek
        // origin'inden (çerezler/localStorage/IndexedDB/Firebase Auth) tamamen
        // izole eder. Bu satırı asla "allow-scripts allow-same-origin" olarak
        // değiştirmeyin — bu, sandbox'ı tamamen etkisiz kılan bilinen bir
        // güvenlik hatasıdır.
        iframe.setAttribute("sandbox", "allow-scripts");
        iframe.style.cssText = "position:absolute; width:0; height:0; border:0; visibility:hidden;";
        iframe.srcdoc = SANDBOX_SRCDOC;

        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error("AI kodu zaman aşımına uğradı (olası sonsuz döngü)."));
        }, SANDBOX_TIMEOUT_MS);

        function cleanup() {
            window.removeEventListener("message", onMessage);
            iframe.remove();
        }

        function onMessage(e) {
            if (settled || e.source !== iframe.contentWindow) return;
            settled = true;
            clearTimeout(timer);
            cleanup();
            if (e.data && e.data.ok) resolve(e.data.nodes || []);
            else reject(new Error((e.data && e.data.error) || "Sandbox hatası."));
        }

        window.addEventListener("message", onMessage);
        iframe.addEventListener("load", () => {
            iframe.contentWindow.postMessage({ code }, "*");
        });
        document.body.appendChild(iframe);
    });
}

const OP_NAME_TO_CONST = { union: ADDITION, subtract: SUBTRACTION, intersect: INTERSECTION };
const ALL_SHAPE_TYPES = ["box", "cylinder", "sphere", "text", "cone", "pyramid", "triprism", "hexprism", "torus", "tube", "dome", "icosahedron", "star", "heart", "roundedbox"];
// NOT: "height" alt sınırları 1 → 0.2 mm'ye indirildi: "0.4mm'ye İncelt" (damga)
// makrosu kaydedilip yeniden yüklenince 1 mm'ye geri KIRPILMASIN.
const NODE_PARAM_LIMITS = {
    box: { width: [1, 300], height: [0.2, 300], depth: [1, 300] },
    cylinder: { radius: [0.5, 200], height: [0.2, 300] },
    sphere: { radius: [0.5, 200] },
    text: { size: [1, 60], depth: [0.2, 30], maxWidth: [0, 500] },
    cone: { radius: [0.5, 200], height: [0.2, 300] },
    pyramid: { radius: [0.5, 200], height: [0.2, 300] },
    triprism: { radius: [0.5, 200], height: [0.2, 300] },
    hexprism: { radius: [0.5, 200], height: [0.2, 300] },
    torus: { radius: [1, 200], tube: [0.3, 100] },
    tube: { outerRadius: [1, 200], innerRadius: [0.3, 199], height: [0.2, 300] },
    dome: { radius: [0.5, 200] },
    icosahedron: { radius: [0.5, 200] },
    star: { radius: [1, 200], depth: [0.2, 60] },
    heart: { size: [1, 200], depth: [0.2, 60] },
    roundedbox: { width: [2, 300], height: [0.2, 300], depth: [2, 300], radius: [0.1, 50] },
};

// NOT (Faz 9 — sertleştirme): `n === null` iken `Number(null)` === 0 döner ve
// `Number.isFinite(0)` === true olduğundan ESKİ kod eksik/null bir parametreyi
// SESSİZCE "0" olarak kabul edip [min,max] aralığına kırpıyordu (fallback'e
// HİÇ düşmüyordu) — yani AI `{params: null}` ya da `{radius: null}` gibi bir
// şey üretirse şekil GERÇEK VARSAYILANI DEĞİL, neredeyse sıfır boyutlu/bozuk
// bir geometri alıyordu. `null`/`undefined`/boş string'i AÇIKÇA "değer yok"
// sayıp fallback'e yönlendiriyoruz.
function clampFinite(n, fallback, min, max) {
    if (n === null || n === undefined || n === "") return fallback;
    const num = Number(n);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
}

// Tek bir HAM node'u doğrulayıp GÜVENLİ bir node'a çevirir; geçersizse throw
// eder (çağıran validateAndConvertNodes bunu yakalayıp SADECE bu elemanı atlar).
function validateOneNode(raw, i) {
    if (!raw || typeof raw !== "object") throw new Error(`${i + 1}. şekil geçersiz (obje değil).`);
    const type = ALL_SHAPE_TYPES.includes(raw.type) ? raw.type : null;
    if (!type) throw new Error(`${i + 1}. şekil tanınmayan tipte: ${raw.type}`);

    const limits = NODE_PARAM_LIMITS[type];
    const params = { ...DEFAULT_PARAMS[type] };
    // raw.params null/undefined/obje-olmayan bir şey OLABİLİR (ör. bozuk AI
    // çıktısı) — bu durumda TÜM parametreler güvenle varsayılana düşsün diye
    // baştan boş bir objeye normalize ediyoruz (aşağıdaki clampFinite zaten
    // null/undefined'ı fallback'e yönlendirir, ama rawParams'ın KENDİSİ obje
    // olmayınca `rawParams[key]` erişimi hataya değil undefined'a düşsün istiyoruz).
    const rawParams = (raw.params && typeof raw.params === "object") ? raw.params : {};
    Object.keys(limits).forEach((key) => {
        const [min, max] = limits[key];
        params[key] = clampFinite(rawParams[key], params[key], min, max);
    });
    if (type === "text") {
        const rawValue = typeof rawParams.value === "string" ? rawParams.value : "METIN";
        params.value = rawValue.replace(/[^\p{L}\p{N}\s.,!?'-]/gu, "").slice(0, 40).trim() || "METIN";
        // Yazı tipi: AI/kaydedilmiş veri sadece whitelist'teki bir font
        // anahtarı belirtebilir — geçersiz/eksikse sessizce varsayılana düşer.
        const rawFont = rawParams.font;
        params.font = (typeof rawFont === "string" && FONT_LIBRARY[rawFont]) ? rawFont : DEFAULT_PARAMS.text.font;
    }
    // Renk: AI sandbox'ından veya kayıtlı bir tasarımdan gelen HAM veri asla
    // güvenilmez — sadece geçerli "#rrggbb" hex string'i kabul edilir,
    // aksi halde o tipin varsayılan rengine sessizce düşer (NODE_PARAM_LIMITS
    // sayısal [min,max] aralıkları kullandığı için renk burada AYRICA
    // doğrulanıyor, aynı "asla güvenme" prensibiyle).
    const rawColor = rawParams.color;
    params.color = isValidHexColor(rawColor) ? rawColor.toLowerCase() : DEFAULT_SHAPE_COLOR;
    // Extruder (IDEX kafası) yalnızca 1 veya 2; inlay yalnızca gerçek `true` bayrağı.
    // Böylece kayıtlı tasarım/AI çıktısı yeniden yüklenince Inlay ve kafa ataması korunur.
    params.extruder = Number(rawParams.extruder) === 2 ? 2 : 1;
    if (rawParams.inlay === true) params.inlay = true;

    const position = Array.isArray(raw.position) ? raw.position : [0, 0, 0];
    const rotation = Array.isArray(raw.rotation) ? raw.rotation : [0, 0, 0];
    const operation = OP_NAME_TO_CONST[raw.operation] ?? ADDITION;

    return {
        type,
        params,
        position: [0, 1, 2].map((k) => clampFinite(position[k], 0, -400, 400)),
        rotation: [0, 1, 2].map((k) => clampFinite(rotation[k], 0, -360, 360)),
        operation,
    };
}

// Sandbox'tan dönen HAM veriyi asla güvenilir kabul etme: her alanı whitelist'e
// ve sayısal sınırlara karşı süzüp GÜVENLİ, temiz bir node listesi döndürür.
// Faz 9 — AGRESİF HATA TOLERANSI: eskiden TEK bir bozuk eleman (`raw.map()`
// içinde throw) TÜM AI üretimini iptal ediyordu. Artık her node KENDİ
// try/catch'i içinde doğrulanıyor — bozuk/tanınmayan bir şekil varsa SADECE O
// ATLANIYOR, geri kalan geçerli şekiller kullanıcıya YİNE DE ulaşıyor.
function validateAndConvertNodes(rawNodes) {
    if (!Array.isArray(rawNodes)) throw new Error("AI çıktısı beklenmeyen formatta.");
    if (rawNodes.length === 0) throw new Error("AI hiçbir şekil üretmedi.");
    if (rawNodes.length > 20) throw new Error("AI çok fazla şekil üretti (maks. 20).");

    const validNodes = [];
    rawNodes.forEach((raw, i) => {
        try {
            validNodes.push(validateOneNode(raw, i));
        } catch (err) {
            console.warn(`AI çıktısında ${i + 1}. şekil atlandı: ${err.message}`, raw);
        }
    });

    if (validNodes.length === 0) {
        throw new Error("AI'nın ürettiği hiçbir şekil geçerli değildi.");
    }

    // MİMARİ KURAL: recompute() boş bir "kimlik" brush'tan başlayıp SOLDAN
    // SAĞA katlar — node listesinde HİÇ "union" (ADDITION) yoksa (hepsi
    // subtract/intersect ise), katlama asla dolu bir gövdeye ulaşamaz ve
    // NİHAİ SONUÇ SESSİZCE TAMAMEN BOŞ/GÖRÜNMEZ olur (teşhisi zor bir "hiçbir
    // şey görünmüyor" şikayetinin klasik kaynağı). Böyle bir durumda TAMAMEN
    // REDDETMEK yerine İLK şekli otomatik union'a çevirerek kendi kendini
    // onarıyoruz — en az sürpriz veren, kullanıcıya yine de bir sonuç
    // gösteren güvenli bir fallback.
    if (!validNodes.some((n) => n.operation === ADDITION)) {
        console.warn("AI çıktısında hiç 'union' şekli yok — sonuç boş olmasın diye ilk şekil otomatik union'a çevrildi.");
        validNodes[0].operation = ADDITION;
    }

    return validNodes;
}

// Doğrulanmış node listesini gerçek Brush'lara çevirir ve TEK bir undo
// adımıyla sahneye ekler (kullanıcı tek Ctrl+Z ile tüm AI üretimini geri alabilir).
async function addValidatedNodesAsGroup(nodes) {
    const brushes = [];
    for (const n of nodes) {
        // Faz 9 — AGRESİF HATA TOLERANSI: bir şeklin geometrisi kurulamazsa
        // (ör. font ağdan yüklenemedi, beklenmedik bir kenar durumu) TÜM AI
        // üretimini iptal etmek yerine SADECE o şekli atlıyoruz — kullanıcı
        // diğer başarıyla oluşturulan şekilleri kaybetmesin.
        try {
            const brush = await createBrush(n.type, n.params);
            brush.operation = n.operation;
            brush.position.set(n.position[0], n.position[1], n.position[2]);
            brush.rotation.set(
                THREE.MathUtils.degToRad(n.rotation[0]),
                THREE.MathUtils.degToRad(n.rotation[1]),
                THREE.MathUtils.degToRad(n.rotation[2])
            );
            brush.updateMatrixWorld();
            brushes.push(brush);
        } catch (err) {
            console.warn(`"${n.type}" şekli oluşturulamadı, atlanıyor:`, err);
        }
    }
    if (brushes.length === 0) {
        throw new Error("Hiçbir şekil oluşturulamadı (konsola bakın).");
    }

    await execute({
        do() { brushes.forEach((b) => csgRoot.add(b)); },
        undo() { brushes.forEach((b) => csgRoot.remove(b)); },
    });

    recompute();
    renderOutliner();
    if (brushes.length) selectNode(brushes[brushes.length - 1]);
    return brushes;
}

function setAIStatus(text, isError) {
    const el = document.getElementById("ai-status-line");
    el.textContent = text;
    el.style.color = isError ? "var(--accent-danger)" : "var(--text-muted)";
}

window.generateWithAI = async function () {
    const promptEl = document.getElementById("ai-prompt");
    const btn = document.getElementById("btn-generate");
    const statusMsg = document.getElementById("status-msg");
    const codePanel = document.getElementById("ai-code-panel");
    const codeEl = document.getElementById("ai-code");

    if (!promptEl.value.trim()) return alert("Lütfen bir tasarım tarifi girin.");

    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="wand-2"></i> Düşünüyor...`;
    refreshIcons();
    statusMsg.innerText = "Yapay zeka modeli tasarlıyor, lütfen bekleyin...";
    setAIStatus("");

    try {
        const res = await fetch("../ai_cad.php", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: promptEl.value }),
        });
        const data = await res.json().catch(() => { throw new Error(`Sunucu Hatası (${res.status})`); });
        if (data.status !== "success") throw new Error(data.message || "AI kodu üretemedi.");

        codeEl.value = data.code;
        codePanel.style.display = "block";
        await window.runAICode();
    } catch (e) {
        alert(e.message);
        statusMsg.innerText = "Hata oluştu.";
        setAIStatus(e.message, true);
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<i data-lucide="wand-2"></i> Üret`;
        refreshIcons();
    }
};

// AI'dan gelen (veya kullanıcının elle düzenlediği) kodu ÇALIŞTIRIR. Kaynağı
// fark etmeksizin HER ZAMAN aynı sandbox + doğrulama hattından geçer.
window.runAICode = async function () {
    const codeEl = document.getElementById("ai-code");
    const statusMsg = document.getElementById("status-msg");
    const code = codeEl.value.trim();
    if (!code) return alert("Çalıştırılacak kod boş.");

    // NOT: setAIStatus() bilerek textContent kullanıyor (innerHTML DEĞİL) —
    // hata mesajı (e.message) sandbox'tan/AI'dan gelen İÇERİĞE bağlı olabilir,
    // bunu innerHTML ile basmak teorik bir XSS riski yaratır. Bu yüzden emoji
    // önekleri yerine burada sade metin kullanılıyor (ikon eklemek innerHTML
    // gerektirirdi) — zaten sade metin de yeterince profesyonel görünüyor.
    setAIStatus("Sandbox'ta izole olarak çalıştırılıyor...");
    try {
        const rawNodes = await runSandboxed(code);
        const nodes = validateAndConvertNodes(rawNodes);
        const brushes = await addValidatedNodesAsGroup(nodes);
        setAIStatus(`${brushes.length} şekil sahneye eklendi.`);
        statusMsg.innerText = `AI: ${brushes.length} şekil eklendi.`;
    } catch (e) {
        console.error("AI-CAD hatası:", e);
        setAIStatus(e.message, true);
        statusMsg.innerText = "AI kodu çalıştırılamadı.";
    }
};

// ═══════════════════════════════════════════════════════════════
// 9. DIŞA AKTARIM VE ERP (Faz 1 kapsamı: gerçek STL / stub ERP)
// ═══════════════════════════════════════════════════════════════

// Faz 12 DÜZELTME (3MF/STL Vertex Normal Hatası): three-bvh-csg'nin evaluate()
// çıktısı NON-INDEXED olabiliyor (her üçgen kendi 3 BAĞIMSIZ köşesine sahip —
// geometrik olarak ÇAKIŞAN komşu üçgen köşeleri AYNI indeksi PAYLAŞMIYOR).
// Dilimleyiciler (Orca, Snapmaker vb.) iç/dış ve kenar tespitini genelde
// PAYLAŞILAN köşe/indeks topolojisine bakarak yapar — paylaşılmayan köşeler
// "açık kenar" / manifold-olmayan bir katı gibi yanlış algılanabiliyordu.
// `mergeVertices()` geometrik olarak çakışan köşeleri TEK bir indekste
// birleştirip GERÇEK indexed/manifold bir mesh üretir; `computeVertexNormals()`
// bu YENİ (birleşmiş) topoloji üzerinden normalleri TAZELER — CSG öncesinden
// kalma/stale normal verisi değil, güncel üçgen sıralamasına göre hesaplanmış
// normaller dışa aktarılır. Orijinal resultMesh.geometry KLONLANIYOR — canlı
// sahne/undo-redo geçmişi bu işlemden ETKİLENMEZ.
function prepareGeometryForExport(sourceGeometry) {
    const geo = mergeVertices(sourceGeometry.clone());
    geo.computeVertexNormals();
    return geo;
}

window.exportSTL = function () {
    if (!resultMesh) return alert("Önce sahneye bir şekil ekleyin.");
    const exportGeo = prepareGeometryForExport(resultMesh.geometry);
    const exportMesh = new THREE.Mesh(exportGeo, resultMesh.material);
    exportMesh.position.copy(resultMesh.position);
    exportMesh.quaternion.copy(resultMesh.quaternion);
    exportMesh.scale.copy(resultMesh.scale);
    const stlString = new STLExporter().parse(exportMesh);
    exportGeo.dispose();
    const blob = new Blob([stlString], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ozisg_tasarim.stl";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    document.getElementById("status-msg").innerText = "STL dosyası indirildi (gerçek CSG geometrisi, taze normaller — Orca Slicer'da açılabilir).";
};

// Minimal ama 3MF Core Spec'e uygun bir "3D/3dmodel.model" XML'i üretir.
// Indexed geometriyi önce non-indexed'e çeviriyoruz (üçgen başına 3 benzersiz
// köşe) — bu yüzden vertex/triangle eşlemesi her zaman i, i+1, i+2 şeklinde
// basit ve hatasız kalıyor (three-bvh-csg'nin evaluate() çıktısının indexed
// olup olmadığını varsaymamıza gerek kalmıyor).
// Faz 5 — ÇOK RENKLİ 3MF: resultMesh'in geometrisi CSG Evaluator'ın
// varsayılan `useGroups=true` davranışı sayesinde her şeklin kendi rengini
// `geometry.groups` ({start,count,materialIndex}) + `material` (dizi) olarak
// zaten taşıyor (bkz. recompute()). Aynı rengi paylaşan TÜM üçgenleri TEK bir
// 3MF <object>'e toplayıp, her renk için ayrı bir <object> + o objeye
// `pid`/`pindex` ile atanan bir <basematerials><base displaycolor=".."/></...>
// yazıyoruz — bu, 3MF Core Spec'in standart (uzantı GEREKTİRMEYEN) renk/
// malzeme mekanizması ve Orca/Bambu/Prusa slicer'ların tümü tarafından
// "her nesneye ayrı ekstruder/filament ata" akışında native destekleniyor.
// Sahnede TEK renk varsa (yaygın/basit durum) doğal olarak TEK bir <object>
// üretilir — eski (tek nesneli) davranışla aynı sonuç, geriye dönük uyumlu.
// IDEX (Snapmaker U1 çift kafa) — Faz 13: parçalar artık SADECE renge değil,
// (extruder, renk) İKİLİSİNE göre ayrı <object>'lere bölünür. Extruder bilgisi
// materyalin userData.extruder alanından okunur (bkz. createBrush / buildColorField;
// CSG sonucu materyal örneklerini koruduğu için birleştirme sonrası da erişilebilir).
// İsteğe bağlı `outInfo` dizisine her <object> için {objId, extruder, hex, triCount}
// eklenir — export3MF bununla dilimleyiciye özel `Slic3r_PE_model.config` dosyasını
// (nesne/parça bazında `extruder` metadata'sı) üretir.
function build3MFModelXML(geometry, material, outInfo) {
    const materials = Array.isArray(material) ? material : [material];
    const groups = (geometry.groups && geometry.groups.length > 0)
        ? geometry.groups
        : [{ start: 0, count: geometry.index ? geometry.index.count : geometry.attributes.position.count, materialIndex: 0 }];

    const pos = geometry.attributes.position;
    const idx = geometry.index;

    // Aynı (extruder, hex) ikilisini paylaşan grupları TEK bir "kova"da (bucket)
    // birleştir — birden fazla orijinal şekil aynı kafa+rengi paylaşıyorsa dosyada
    // gereksiz yere ayrı ayrı nesneler oluşmasın; farklı kafaya atanmış parçalar
    // (aynı renkte bile olsa) AYRI nesne olur ki dilimleyici 2 ayrı filament görsün.
    const buckets = new Map(); // "ext|hex" -> { extruder, hex, verts:[[x,y,z]], tris:[[a,b,c]], vertMap:Map }
    function bucketFor(extruder, hex) {
        const key = `${extruder}|${hex}`;
        if (!buckets.has(key)) buckets.set(key, { extruder, hex, verts: [], tris: [], vertMap: new Map() });
        return buckets.get(key);
    }
    function localIndex(bucket, globalVertIdx) {
        if (!bucket.vertMap.has(globalVertIdx)) {
            bucket.vertMap.set(globalVertIdx, bucket.verts.length);
            bucket.verts.push([pos.getX(globalVertIdx), pos.getY(globalVertIdx), pos.getZ(globalVertIdx)]);
        }
        return bucket.vertMap.get(globalVertIdx);
    }

    groups.forEach((g) => {
        const mat = materials[g.materialIndex] || materials[0];
        const hex = (mat && mat.color) ? mat.color.getHexString() : "2e6cd1";
        const extruder = (mat && mat.userData && Number(mat.userData.extruder) === 2) ? 2 : 1;
        const bucket = bucketFor(extruder, hex);
        for (let i = g.start; i < g.start + g.count; i += 3) {
            const a = idx ? idx.getX(i) : i;
            const b = idx ? idx.getX(i + 1) : i + 1;
            const c = idx ? idx.getX(i + 2) : i + 2;
            bucket.tris.push([localIndex(bucket, a), localIndex(bucket, b), localIndex(bucket, c)]);
        }
    });

    // Kafa 1'dekiler önce, sonra Kafa 2 (aynı kafada renk ekleniş sırası korunur).
    const bucketList = [...buckets.values()].sort((a, b) => a.extruder - b.extruder);
    const baseLines = bucketList.map((b) => `<base name="Kafa ${b.extruder} - #${b.hex.toUpperCase()}" displaycolor="#${b.hex.toUpperCase()}FF"/>`);

    let nextId = 2; // id=1: <basematerials>
    const objectBlocks = bucketList.map((bucket, bucketIdx) => {
        const vertexLines = bucket.verts.map((v) => `<vertex x="${v[0].toFixed(4)}" y="${v[1].toFixed(4)}" z="${v[2].toFixed(4)}"/>`).join("");
        const triangleLines = bucket.tris.map((t) => `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`).join("");
        const objId = nextId++;
        if (Array.isArray(outInfo)) outInfo.push({ objId, extruder: bucket.extruder, hex: bucket.hex, triCount: bucket.tris.length });
        return {
            objId,
            xml: `<object id="${objId}" type="model" name="Kafa ${bucket.extruder} - #${bucket.hex.toUpperCase()}" pid="1" pindex="${bucketIdx}">
      <mesh>
        <vertices>${vertexLines}</vertices>
        <triangles>${triangleLines}</triangles>
      </mesh>
    </object>`,
        };
    });

    const itemLines = objectBlocks.map((o) => `<item objectid="${o.objId}"/>`).join("");

    return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="tr-TR" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <basematerials id="1">
      ${baseLines.join("\n      ")}
    </basematerials>
    ${objectBlocks.map((o) => o.xml).join("\n    ")}
  </resources>
  <build>
    ${itemLines}
  </build>
</model>`;
}

// Prusa/Orca uyumlu `Metadata/Slic3r_PE_model.config`: her <object> için (ve tek
// hacmi için) `extruder` metadata'sı — dilimleyici böylece "Kafa 2" parçayı 2.
// filament/extruder'a atanmış olarak açar (renk eşleştirmeye güvenmek yerine
// doğrudan atama). Standart 3MF okuyucular bu dosyayı yok sayar.
function build3MFConfigXML(objectInfos) {
    const objects = objectInfos.map((o) => {
        const name = `Kafa ${o.extruder} - #${o.hex.toUpperCase()}`;
        return ` <object id="${o.objId}" instances_count="1">
  <metadata type="object" key="name" value="${name}"/>
  <metadata type="object" key="extruder" value="${o.extruder}"/>
  <volume firstid="0" lastid="${Math.max(0, o.triCount - 1)}">
   <metadata type="volume" key="name" value="${name}"/>
   <metadata type="volume" key="volume_type" value="ModelPart"/>
   <metadata type="volume" key="extruder" value="${o.extruder}"/>
  </volume>
 </object>`;
    }).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${objects}\n</config>`;
}

window.export3MF = function () {
    if (!resultMesh) return alert("Önce sahneye bir şekil ekleyin.");

    const exportGeo = prepareGeometryForExport(resultMesh.geometry);
    const objectInfos = [];
    const modelXML = build3MFModelXML(exportGeo, resultMesh.material, objectInfos);
    exportGeo.dispose();
    const configXML = build3MFConfigXML(objectInfos);

    const contentTypesXML = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
  <Default Extension="config" ContentType="text/xml"/>
</Types>`;

    const relsXML = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

    // Faz 5: build3MFModelXML artık renk başına AYRI bir 3MF <object> +
    // <basematerials> girdisi üretiyor (bkz. yukarısı) — Snapmaker U1'in çift
    // kafasıyla (IDEX) her rengi ayrı bir ekstrudere/filamana atamak artık
    // Orca Slicer'da mümkün. CSG boolean işlemleri parça sınırlarını
    // (Outliner düğümlerini) geri dönüşsüz eritmeye devam ediyor — bu yüzden
    // ayrım "orijinal şekil" değil "nihai renk" bazında yapılıyor.
    const zipped = zipSync({
        "[Content_Types].xml": strToU8(contentTypesXML),
        "_rels/.rels": strToU8(relsXML),
        "3D/3dmodel.model": strToU8(modelXML),
        "Metadata/Slic3r_PE_model.config": strToU8(configXML),
    });

    const blob = new Blob([zipped], { type: "application/vnd.ms-package.3dmanufacturing-3dmodel+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ozisg_tasarim.3mf";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    document.getElementById("status-msg").innerText = "3MF dosyası indirildi (Snapmaker Orca Slicer'da açılabilir).";
};

// ═══════════════════════════════════════════════════════════════
// 9. FIRESTORE ERP — SİPARİŞ/TASARIM GEÇMİŞİ (Faz 4)
// ═══════════════════════════════════════════════════════════════
//
// Model: `tool_3d_designs` koleksiyonu — EKLEME-BAZLI versiyonlama. Her
// "Kaydet" YENİ bir döküman oluşturur (üzerine yazma yok), böylece eski
// sürümler asla kaybolmaz; bir tasarımı yükleyip düzenleyip tekrar
// kaydetmek `sourceDesignId` ile eski kayda bağlı yeni bir kayıt üretir.
//
// Şema: aynı düz "node listesi" (type/params/position/rotation/operation)
// AI-CAD sandbox'ının ürettiği formatla BİREBİR aynı — bu sayede kaydetme,
// yükleme ve AI üretimi TEK bir doğrulama/kurma hattını (validateAndConvertNodes
// + addValidatedNodesAsGroup) paylaşıyor, ayrı bir format icat edilmedi.
//
// KAPSAM DIŞI (bilerek): STL/SVG içe aktarılan parçalar ham mesh verisi
// taşıdığı için bu düz node formatına sığmıyor — kaydedilirken atlanıyor ve
// kullanıcı açıkça uyarılıyor (sessizce veri kaybı YOK).

const OP_CONST_TO_NAME = { [ADDITION]: "union", [SUBTRACTION]: "subtract", [INTERSECTION]: "intersect" };
let currentUser = null;
let currentDesignId = null;

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
}

// Sahneyi AI-CAD sandbox'ıyla aynı düz node listesine çevirir. Sadece
// parametrik şekiller (box/cylinder/sphere/text) dahil edilir.
// Faz 8: Sık Kullanılanlar özelliği de AYNI düz "node listesi" formatını
// (AI-CAD sandbox'ı/kayıt/yükleme ile birebir) kullanabilsin diye asıl mantık
// KEYFİ bir brush listesi alacak şekilde genelleştirildi — serializeSceneToNodes()
// artık sadece bunu TÜM sahne (csgRoot.children) ile çağıran ince bir sarmalayıcı.
function serializeBrushesToNodes(list) {
    return list
        .filter((b) => Object.prototype.hasOwnProperty.call(DEFAULT_PARAMS, b.userData.type))
        .map((b) => ({
            type: b.userData.type,
            params: { ...b.userData.params },
            position: b.position.toArray(),
            rotation: [
                THREE.MathUtils.radToDeg(b.rotation.x),
                THREE.MathUtils.radToDeg(b.rotation.y),
                THREE.MathUtils.radToDeg(b.rotation.z),
            ],
            operation: OP_CONST_TO_NAME[b.operation] || "union",
        }));
}

function serializeSceneToNodes() {
    return serializeBrushesToNodes(csgRoot.children);
}

// ═══════════════════════════════════════════════════════════════
// 9b. SIK KULLANILANLAR — Kişisel Şekil Kütüphanesi (Faz 8)
// ═══════════════════════════════════════════════════════════════
// KAPSAM/GÜVENLİK: localStorage'a yazılan veri de (tıpkı Firestore'dan gelen
// kayıtlı tasarımlar veya AI sandbox çıktısı gibi) ASLA doğrudan güvenilmez —
// sahneye eklerken HER ZAMAN validateAndConvertNodes() süzgecinden geçer. Bu,
// tarayıcı DevTools'undan localStorage'ı elle bozan bir kullanıcının bile
// geçersiz/aşırı büyük parametrelerle sahneyi bozmasını engeller — AYRI bir
// güvenlik hattı icat ETMEDİK, var olanı yeniden kullandık.
const FAVORITES_KEY = "ozisg_favorites";

function loadFavoritesFromStorage() {
    try {
        const raw = localStorage.getItem(FAVORITES_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
    } catch (err) {
        console.warn("Favoriler okunamadı (bozuk localStorage verisi):", err);
        return [];
    }
}

function saveFavoritesToStorage(list) {
    try {
        localStorage.setItem(FAVORITES_KEY, JSON.stringify(list));
    } catch (err) {
        console.error("Favoriler kaydedilemedi:", err);
        alert("Favori kaydedilemedi (tarayıcı depolama alanı dolu olabilir).");
    }
}

function renderFavorites() {
    const list = document.getElementById("favorites-list");
    if (!list) return; // HTML henüz yüklenmemiş olabilir (savunma amaçlı)
    const favorites = loadFavoritesFromStorage();
    if (favorites.length === 0) {
        list.innerHTML = `<li class="empty-hint">Henüz favori yok. Bir şekil seçip "Favorilere Ekle"ye basın.</li>`;
        return;
    }
    list.innerHTML = favorites.map((fav) => `
        <li class="favorite-row" data-fav-id="${fav.id}" title="Sahneye Ekle: ${escapeHtml(fav.name)}">
            <span class="fav-name">${escapeHtml(fav.name)}</span>
            <button class="fav-del" data-fav-del title="Sil"><i data-lucide="trash-2"></i></button>
        </li>
    `).join("");
    list.querySelectorAll(".favorite-row").forEach((row) => {
        const id = row.dataset.favId;
        row.addEventListener("click", (e) => {
            if (e.target.closest("[data-fav-del]")) return;
            window.addFavoriteToScene(id);
        });
        row.querySelector("[data-fav-del]").addEventListener("click", () => window.deleteFavorite(id));
    });
    refreshIcons();
}

// Seçili şekil(ler)i tek bir şablon olarak localStorage'a kaydeder. STL/SVG/
// Fotoğraf gibi parametrik olmayan parçalar (Kaydet/AI ile aynı kısıt gereği)
// şablona dahil edilmez.
window.addSelectionToFavorites = function () {
    const list = activeSelectionList();
    if (list.length === 0) return;
    const nodes = serializeBrushesToNodes(list);
    if (nodes.length === 0) {
        return alert("İçe aktarılan (STL/SVG/Fotoğraf) parçalar favori olarak kaydedilemiyor.");
    }
    const name = prompt("Favori adı:", labelFor(list[0].userData.type) + (list.length > 1 ? ` +${list.length - 1}` : ""));
    if (name === null) return;

    const favorites = loadFavoritesFromStorage();
    favorites.unshift({ id: `fav_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, name: name.trim() || "Adsız Favori", createdAt: Date.now(), nodes });
    saveFavoritesToStorage(favorites);
    renderFavorites();
    document.getElementById("status-msg").innerText = `"${name.trim() || "Adsız Favori"}" favorilere eklendi.`;
};

// Bir favoriyi sahneye YENİ bir kopya olarak ekler — AI-CAD/kayıtlı tasarım
// yükleme ile AYNI güvenli doğrulama+kurma hattından (validateAndConvertNodes
// + addValidatedNodesAsGroup) geçer, tek bir undo adımı olarak kaydedilir.
window.addFavoriteToScene = async function (id) {
    const favorites = loadFavoritesFromStorage();
    const fav = favorites.find((f) => f.id === id);
    if (!fav) return;
    try {
        const nodes = validateAndConvertNodes(fav.nodes);
        await addValidatedNodesAsGroup(nodes);
        document.getElementById("status-msg").innerText = `"${fav.name}" sahneye eklendi.`;
    } catch (err) {
        console.error("addFavoriteToScene:", err);
        alert("Favori sahneye eklenirken hata oluştu: " + err.message);
    }
};

window.deleteFavorite = function (id) {
    const favorites = loadFavoritesFromStorage();
    const fav = favorites.find((f) => f.id === id);
    if (!fav) return;
    if (!confirm(`"${fav.name}" favorisini silmek istediğinize emin misiniz?`)) return;
    saveFavoritesToStorage(favorites.filter((f) => f.id !== id));
    renderFavorites();
};

function clearScene() {
    [...csgRoot.children].forEach((b) => { csgRoot.remove(b); b.geometry.dispose(); });
    history.stack = [];
    history.pointer = -1;
    refreshUndoRedoButtons();
    selectNode(null);
    recompute();
    renderOutliner();
}

window.saveDesign = async function () {
    if (!currentUser) return alert("Kaydetmek için giriş yapmalısınız.");
    if (csgRoot.children.length === 0) return alert("Sahne boş, kaydedilecek bir şey yok.");

    const importCount = csgRoot.children.filter(
        (b) => isNonParametricType(b.userData.type)
    ).length;
    const nodes = serializeSceneToNodes();

    if (importCount > 0) {
        const proceed = confirm(
            `Sahnede ${importCount} adet içe aktarılmış STL/SVG/Fotoğraf parçası var. ` +
            `Bu ilk sürüm kaydı bu parçaları henüz saklamıyor — sadece ${nodes.length} ` +
            `parametrik şekil kaydedilecek, içe aktarılanlar kayıptan sonra sahnede kalmaya ` +
            `devam eder ama geri yüklendiğinde GELMEZ. Devam edilsin mi?`
        );
        if (!proceed) return;
    }
    if (nodes.length === 0) return alert("Kaydedilecek parametrik şekil yok (sadece içe aktarılmış dosyalar var).");

    const nameInput = document.getElementById("design-name");
    const name = nameInput.value.trim() || `Tasarım ${new Date().toLocaleString("tr-TR")}`;

    const box = new THREE.Box3().setFromObject(resultMesh);
    const size = box.getSize(new THREE.Vector3());
    const triCount = resultMesh.geometry.attributes.position.count / 3;

    const btn = document.querySelector('#save-box button');
    btn.disabled = true;
    try {
        const docRef = await addDoc(collection(db, "tool_3d_designs"), {
            userId: currentUser.uid,
            name,
            nodes,
            triangleCount: Math.round(triCount),
            boundingSize: { x: +size.x.toFixed(2), y: +size.y.toFixed(2), z: +size.z.toFixed(2) },
            sourceDesignId: currentDesignId || null,
            createdAt: serverTimestamp(),
        });
        currentDesignId = docRef.id;
        showToast(`"${name}" kaydedildi.`, "success");
        nameInput.value = "";
        document.getElementById("status-msg").innerText = `"${name}" ERP'ye kaydedildi.`;
        window.loadDesignsList();
    } catch (err) {
        console.error("saveDesign:", err);
        alert("Kaydetme sırasında hata oluştu: " + err.message);
    } finally {
        btn.disabled = false;
    }
};

window.loadDesignsList = async function () {
    const list = document.getElementById("designs-list");
    if (!currentUser) {
        list.innerHTML = `<li class="empty-hint">Giriş yapınca kayıtlı tasarımlarınız burada görünür.</li>`;
        return;
    }
    list.innerHTML = `<li class="empty-hint">Yükleniyor...</li>`;
    try {
        const q = query(
            collection(db, "tool_3d_designs"),
            where("userId", "==", currentUser.uid),
            orderBy("createdAt", "desc"),
            limit(30)
        );
        const snap = await getDocs(q);
        if (snap.empty) {
            list.innerHTML = `<li class="empty-hint">Henüz kayıtlı tasarım yok.</li>`;
            return;
        }
        list.innerHTML = "";
        snap.forEach((docSnap) => {
            const d = docSnap.data();
            const when = d.createdAt && d.createdAt.toDate ? d.createdAt.toDate().toLocaleString("tr-TR") : "—";
            const size = d.boundingSize ? `${d.boundingSize.x}×${d.boundingSize.y}×${d.boundingSize.z}mm` : "";
            const row = document.createElement("li");
            row.className = "design-row";
            row.innerHTML = `
                <div class="d-info">
                    <div class="d-name">${escapeHtml(d.name || "Adsız")}</div>
                    <div class="d-meta">${when} · ${d.triangleCount || 0} üçgen · ${size}</div>
                </div>
                <button class="d-load" title="Sahneye Yükle"><i data-lucide="folder-open"></i></button>
                <button class="d-del" title="Sil"><i data-lucide="trash-2"></i></button>
            `;
            row.querySelector(".d-load").addEventListener("click", () => window.loadDesign(docSnap.id));
            row.querySelector(".d-del").addEventListener("click", () => window.deleteDesignRecord(docSnap.id, d.name));
            list.appendChild(row);
        });
        refreshIcons();
    } catch (err) {
        console.error("loadDesignsList:", err);
        list.innerHTML = `<li class="empty-hint">Yüklenirken hata oluştu (konsola bakın).</li>`;
    }
};

window.loadDesign = async function (id) {
    if (csgRoot.children.length > 0 && !confirm("Mevcut sahne temizlenip bu tasarım yüklenecek. Kaydedilmemiş değişiklikler kaybolur. Devam edilsin mi?")) {
        return;
    }
    try {
        const snap = await getDoc(doc(db, "tool_3d_designs", id));
        if (!snap.exists()) return alert("Tasarım bulunamadı (silinmiş olabilir).");
        const data = snap.data();
        const nodes = validateAndConvertNodes(data.nodes || []);

        clearScene();
        currentDesignId = id;
        await addValidatedNodesAsGroup(nodes);
        document.getElementById("design-name").value = data.name || "";
        document.getElementById("status-msg").innerText = `"${data.name || "Adsız"}" sahneye yüklendi.`;
        window.resetCamera();
    } catch (err) {
        console.error("loadDesign:", err);
        alert("Yükleme sırasında hata oluştu: " + err.message);
    }
};

window.deleteDesignRecord = async function (id, name) {
    if (!confirm(`"${name || "Adsız"}" tasarımını kalıcı olarak silmek istediğinize emin misiniz?`)) return;
    try {
        await deleteDoc(doc(db, "tool_3d_designs", id));
        showToast("Tasarım silindi.", "success");
        window.loadDesignsList();
    } catch (err) {
        console.error("deleteDesignRecord:", err);
        alert("Silme sırasında hata oluştu: " + err.message);
    }
};

// ═══════════════════════════════════════════════════════════════
// 10. BAŞLAT
// ═══════════════════════════════════════════════════════════════

window.addEventListener("load", async () => {
    currentUser = await requireToolAccess("tool_3d_atolyesi", {
        loadingEl: "page-loading", authGateEl: "auth-gate", mainEl: "main-content",
    });
    if (!currentUser) return; // requireToolAccess zaten uygun ekranı gösterdi

    init3D();
    renderOutliner();
    renderInspector();
    refreshUndoRedoButtons();
    window.loadDesignsList();
    renderFavorites(); // Faz 8 — localStorage'daki Sık Kullanılanlar listesi
    // Faz 7 — sayfadaki TÜM statik <i data-lucide="..."> etiketlerini (ribbon
    // araç çubuğu, panel başlıkları, yardım modalı vb.) dönüştür. Dinamik
    // olarak yeniden çizilen bölümler (renderShapeGrid/renderOutliner/
    // renderInspector/loadDesignsList) kendi refreshIcons() çağrılarını zaten
    // yapıyor; bu, İLK yüklemedeki geri kalan HER ŞEYİ kapsıyor.
    refreshIcons();
});
