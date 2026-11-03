/**
 * Dataset kata bertema untuk game tebak gambar.
 * Setiap tema berisi daftar kata sederhana yang mudah digambar.
 */

const CATEGORIES = {
  hewan: {
    label: "Hewan",
    words: [
      "kucing", "anjing", "gajah", "singa", "harimau", "zebra", "jerapah",
      "kuda", "sapi", "kambing", "ayam", "bebek", "burung", "elang", "burung hantu",
      "ikan", "paus", "hiu", "lumba lumba", "udang", "kepiting", "bintang laut",
      "kura kura", "ular", "kodok", "buaya", "banteng", "kelinci", "tikus", "monyet",
      "panda", "koala", "kangguru", "landak", "kutu", "kelelawar",
      "semut", "lebah", "belalang", "capung", "keong", "siput", "cacing",
      "serigala", "rusa", "musang", "tupai", "kupu kupu",
    ],
  },
  makanan: {
    label: "Makanan & Minuman",
    words: [
      "nasi", "mie", "roti", "bakso", "sate", "rendang", "soto", "gado gado",
      "pizza", "burger", "hotdog", "kentang goreng", "spageti", "sushi", "tempura",
      "sup", "salad", "telur", "keju", "mentega", "susu", "yogurt", "es krim",
      "kue", "donat", "kue tart", "coklat", "permen", "biskuit", "popcorn",
      "apel", "pisang", "jeruk", "anggur", "semangka", "mangga", "nanas",
      "strawberry", "kelapa", "alpukat", "durian", "pepaya",
      "kopi", "teh", "jus", "air mineral", "soda", "jus jeruk",
    ],
  },
  benda: {
    label: "Benda Sehari-hari",
    words: [
      "meja", "kursi", "lemari", "kasur", "bantal", "guling", "cermin", "lampu",
      "kipas angin", "televisi", "radio", "kulkas", "kompor", "panci", "wajan",
      "gelas", "piring", "sendok", "garpu", "pisau", "piring saji", "botol",
      "payung", "tas", "dompet", "kunci", "jam", "sapu",
      "sikat gigi", "sampo", "sabun", "handuk", "sepatu", "topi", "kacamata",
      "jaket", "kaos kaki", "sarung tangan", "ikat pinggang",
      "gunting", "pensil", "penghapus", "buku", "buku gambar", "tempat pensil",
    ],
  },
  olahraga: {
    label: "Olahraga",
    words: [
      "sepak bola", "basket", "voli", "badminton", "tenis", "tenis meja",
      "renang", "lari", "gymnastik", "senam", "yoga", "silat", "karate",
      "tinju", "gulat", "panahan", "golf", "balap motor", "balap sepeda",
      "selancar", "ski", "panjat tebing", "layangan", "futsal", "hoki",
      "dayung", "kriket", "rugby", "bola tangan",
      "sepeda gunung", "barbel", "helm", "sepatu lari", "piala", "medali", "wasit",
    ],
  },
  profesi: {
    label: "Profesi",
    words: [
      "dokter", "perawat", "guru", "dokter gigi", "petani", "nelayan", "peternak",
      "pilot", "pramugari", "koki", "pelayan", "polisi", "pemadam kebakaran",
      "tentara", "presiden", "gubernur", "pengacara", "hakim", "wartawan",
      "aktor", "penyanyi", "pelukis", "pemusik", "penari", "sirkus",
      "insinyur", "programmer", "desainer", "arsitek", "tukang", "montir",
      "sopir", "pengantar surat", "petugas kebun", "perias", "penjahit",
      "penata rambut", "tukang cukur",
    ],
  },
  transportasi: {
    label: "Transportasi",
    words: [
      "mobil", "motor", "sepeda", "bus", "truk", "ambulans", "taksi", "traktor",
      "kapal", "sampan", "pesawat", "helikopter", "roket", "kereta api", "metro",
      "becak", "andong", "ojek", "skuter", "delman", "gondola",
      "kapal layar", "perahu motor", "kapal feri", "perahu penyelamat", "kapal selam",
      "papan luncur", "sepatu roda", "kereta gantung", "trem",
    ],
  },
  alam: {
    label: "Alam & Tempat",
    words: [
      "gunung", "sungai", "danau", "laut", "pantai", "air terjun", "hutan",
      "padang rumput", "gurun", "pulau", "kawah", "gunung es", "awan", "hujan",
      "petir", "pelangi", "matahari", "bulan", "bintang", "komet", "matahari terbit",
      "pohon", "bunga", "rumput", "batu", "pasir", "tanah", "lubang", "sarang",
      "rumah", "gedung", "menara", "jembatan", "jalan", "taman", "kebun binatang",
      "masjid", "gereja", "pura", "istana", "benteng", "pasar",
    ],
  },
  teknologi: {
    label: "Teknologi",
    words: [
      "komputer", "laptop", "ponsel", "tablet", "printer", "kamera", "robot",
      "drone", "kalkulator", "mouse", "keyboard", "layar monitor", "headset",
      "speaker", "sinyal wifi", "baterai", "stop kontak", "lampu senter",
      "satelit", "teleskop", "mikroskop", "jam tangan pintar", "kabel data",
      "server", "awan penyimpanan", "mesin cuci", "vacuum cleaner", "microwave",
      "oven", "pendingin ruangan", "proyektor",
    ],
  },
  hiburan: {
    label: "Film & Hiburan",
    words: [
      "bioskop", "gitar", "piano", "drum", "biola", "suling", "mikrofon",
      "topeng", "kacamata panggung", "tiket", "panggung", "balon", "kembang api",
      "boneka", "wayang", "kartu", "papan permainan", "dadu", "catur",
      "bola pesta", "kue ulang tahun", "hadiah", "peti harta", "mahkota",
      "pedang", "perisai", "panah", "busur", "jubah", "topi sihir",
      "kartun", "komik", "gambar", "lukisan", "kuas", "palet cat",
    ],
  },
  sekolah: {
    label: "Sekolah & Belajar",
    words: [
      "papan tulis", "kapur tulis", "spidol", "buku tulis", "seragam sekolah",
      "tas ransel", "kotak pensil", "globe", "peta", "rapor", "ujian",
      "perpustakaan", "kelas", "bel sekolah", "meja guru", "pensil warna",
      "krayon", "lem", "penggaris", "jangka", "jadwal pelajaran",
      "papan pengumuman", "upacara bendera", "laboratorium", "kotak bekal",
      "tempat sampah",
    ],
  },
  pakaian: {
    label: "Pakaian & Aksesori",
    words: [
      "kemeja", "kaos oblong", "celana panjang", "celana pendek", "rok", "gaun",
      "jas", "sweter", "piyama", "celana jeans", "syal", "sarung", "peci",
      "topi jerami", "sepatu bot", "sandal jepit", "sepatu olahraga", "jam tangan",
      "gelang", "kalung", "anting", "cincin", "kacamata hitam", "ikat rambut",
      "rompi", "baju renang",
    ],
  },
};

const ALL_CATEGORIES = Object.keys(CATEGORIES);

function listThemes() {
  return ALL_CATEGORIES.map((key) => ({ key, label: CATEGORIES[key].label }));
}

/**
 * Ambil n kata acak dari tema tertentu. theme "random" mencampur semua tema.
 */
function pickWords(theme, count = 3, exclude = []) {
  const pool = theme && theme !== "random" && CATEGORIES[theme]
    ? CATEGORIES[theme].words.slice()
    : ALL_CATEGORIES.flatMap((k) => CATEGORIES[k].words.map((w) => [k, w]))
      .map(([k, w]) => w);
  const banned = new Set(exclude.map((w) => w.toLowerCase()));
  const avail = pool.filter((w) => !banned.has(w.toLowerCase()));
  const source = avail.length >= count ? avail : pool;
  const out = [];
  const copy = source.slice();
  while (out.length < count && copy.length) {
    const i = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(i, 1)[0]);
  }
  return out;
}

function themeLabel(theme) {
  if (!theme || theme === "random") return "Campuran";
  return CATEGORIES[theme] ? CATEGORIES[theme].label : theme;
}

module.exports = { CATEGORIES, ALL_CATEGORIES, listThemes, pickWords, themeLabel };