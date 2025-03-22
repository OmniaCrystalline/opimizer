/** @format */

const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const cors = require("cors");
const path = require("path");
const fs = require("fs").promises;
const os = require("os");
const { exec } = require("child_process");

const app = express();

// Налаштування CORS для продакшену
const corsOptions = {
  origin:
    process.env.NODE_ENV === "production"
      ? ["https://opimizer.onrender.com", "http://localhost:3000"]
      : ["http://localhost:3000"],
  optionsSuccessStatus: 200,
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());

// Визначаємо базову директорію в залежності від середовища
const STORAGE_BASE =
  process.env.NODE_ENV === "production"
    ? path.join(os.tmpdir(), "processed_images")
    : path.join(os.homedir(), "Downloads", "processed_images");

// Додаємо статичний роут для доступу до оброблених зображень
app.use(
  "/processed_images",
  express.static(path.join(process.cwd(), "public", "processed_images"))
);

// Перевіряємо наявність директорії для збереження
async function ensureStorageDir() {
  try {
    await fs.access(STORAGE_BASE);
    console.log(`Storage directory exists: ${STORAGE_BASE}`);
  } catch (error) {
    // Якщо директорії немає - створюємо її
    await fs.mkdir(STORAGE_BASE, { recursive: true });
    console.log(`Created storage directory: ${STORAGE_BASE}`);
  }
}

// Налаштування multer для тимчасового збереження файлів
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, os.tmpdir());
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname);
  },
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // Обмеження розміру файлу (10MB)
    files: 10, // Максимальна кількість файлів
  },
});

// Додаємо маршрут для кореневої сторінки
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Конфігурація розмірів для різних категорій
const imageConfigs = {
  hero: { width: 1920, height: 1080, watermark: true },
  heroRetina: { width: 3840, height: 2160, watermark: true },
  card: { width: 400, height: 300, watermark: true },
  cardRetina: { width: 800, height: 600, watermark: true },
};

// Функція для створення SVG вотермарки з текстом
async function createWatermarkSvg(text) {
  const svg = `
    <svg width="500" height="100">
      <style>
        .text { fill: rgba(255, 255, 255, 0.5); font-size: 48px; font-family: Arial; }
      </style>
      <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" class="text">${text}</text>
    </svg>
  `;

  const tempFile = path.join(
    require("os").tmpdir(),
    `watermark-${Date.now()}.svg`
  );
  await fs.writeFile(tempFile, svg);
  return tempFile;
}

// Функція для обробки зображення
async function processImage(file, config, targetFolder, watermarkText) {
  try {
    const filename = path.parse(file.originalname).name;
    const timestamp = Date.now();
    const isRetina = config.width > 1920;
    const sizeFolder = `${config.width}x${config.height}`;
    const outputDir = path.join(targetFolder, sizeFolder);

    await fs.mkdir(outputDir, { recursive: true });

    // Формуємо назву файлу з розміром та позначкою ретіни
    const size = isRetina
      ? config.width === 3840
        ? "1920x1080@2x"
        : "400x300@2x"
      : config.width === 1920
      ? "1920x1080"
      : "400x300";

    const outputFilename = `${filename}_${size}_${timestamp}.webp`;
    const outputPath = path.join(outputDir, outputFilename);

    console.log(`Processing image: ${file.path} -> ${outputPath}`);
    console.log(`Config: ${JSON.stringify(config)}`);

    let imageProcess = sharp(file.path)
      .resize(config.width, config.height, {
        fit: "cover",
        position: "center",
      })
      .modulate({
        brightness: 1.1,
        saturation: 1.2,
      });

    if (config.watermark) {
      try {
        const watermarkPath = await createWatermarkSvg(watermarkText);
        // Збільшуємо розмір вотермарки для ретіна зображень
        const watermarkWidth = isRetina
          ? Math.floor(config.width * 0.5)
          : Math.floor(config.width * 0.3);
        const watermarkBuffer = await sharp(watermarkPath)
          .resize(watermarkWidth, null, { fit: "inside" })
          .toBuffer();

        imageProcess = imageProcess.composite([
          {
            input: watermarkBuffer,
            gravity: "southeast",
            blend: "over",
          },
        ]);

        await fs.unlink(watermarkPath);
      } catch (error) {
        console.error("Error processing watermark:", error);
      }
    }

    // Збільшуємо якість для ретіна зображень
    const quality = isRetina ? 80 : 90;
    await imageProcess.webp({ quality }).toFile(outputPath);
    console.log(`Image processed successfully: ${outputPath}`);
    return outputPath;
  } catch (error) {
    console.error("Error in processImage:", error);
    throw error;
  }
}

// Функція для логування помилок
function logError(context, error) {
  console.error(`=== Error in ${context} ===`);
  console.error("Message:", error.message);
  console.error("Stack:", error.stack);
  console.error("Additional info:", {
    platform: process.platform,
    nodeVersion: process.version,
    env: process.env.NODE_ENV,
    tmpDir: os.tmpdir(),
    freeMemory: os.freemem(),
    totalMemory: os.totalmem(),
  });
  console.error("========================");
}

// Перевіряємо права доступу до директорій
async function checkDirectoryAccess(dir) {
  try {
    await fs.access(dir, fs.constants.R_OK | fs.constants.W_OK);
    const stats = await fs.stat(dir);
    console.log(`Directory ${dir} access check:`, {
      readable: true,
      writable: true,
      isDirectory: stats.isDirectory(),
      mode: stats.mode,
      uid: stats.uid,
      gid: stats.gid,
    });
    return true;
  } catch (error) {
    logError(`checkDirectoryAccess(${dir})`, error);
    return false;
  }
}

// Оновлюємо маршрут для обробки зображень
app.post("/process-images", upload.array("images"), async (req, res) => {
  try {
    console.log("=== New request received ===");
    console.log("Headers:", req.headers);
    console.log("Body:", req.body);
    console.log(
      "Files:",
      req.files?.map((f) => ({
        name: f.originalname,
        size: f.size,
        mimetype: f.mimetype,
        path: f.path,
      }))
    );

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    if (!req.body.watermarkText) {
      return res.status(400).json({ error: "Watermark text is required" });
    }

    const watermarkText = req.body.watermarkText.trim().startsWith("©")
      ? req.body.watermarkText.trim()
      : `© ${req.body.watermarkText.trim()}`;

    const currentDate = new Date().toISOString().split("T")[0];
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const targetFolder = path.join(STORAGE_BASE, currentDate, timestamp);

    await fs.mkdir(targetFolder, { recursive: true });
    console.log(`Created target folder: ${targetFolder}`);

    const results = [];
    const downloadUrls = [];

    for (const file of req.files) {
      try {
        console.log(`Processing file: ${file.originalname}`);
        const processedImages = {};

        for (const [configName, config] of Object.entries(imageConfigs)) {
          try {
            console.log(`Processing ${configName} version...`);
            const outputPath = await processImage(
              file,
              config,
              targetFolder,
              watermarkText
            );

            if (process.env.NODE_ENV === "production") {
              // На продакшені створюємо URL для завантаження
              const downloadUrl = `/download?file=${encodeURIComponent(
                outputPath
              )}`;
              processedImages[configName] = downloadUrl;
              downloadUrls.push(outputPath);
            } else {
              // Локально використовуємо file:// протокол
              processedImages[configName] = `file://${outputPath}`;
            }

            console.log(`Successfully processed ${configName} version`);
          } catch (error) {
            logError(`processImage(${configName})`, error);
            processedImages[configName] = { error: error.message };
          }
        }

        results.push({
          originalName: file.originalname,
          folder: process.env.NODE_ENV === "production" ? null : targetFolder,
          processed: processedImages,
        });

        await fs.unlink(file.path);
      } catch (error) {
        logError(`Processing file ${file.originalname}`, error);
        results.push({
          originalName: file.originalname,
          error: error.message,
        });
      }
    }

    if (results.length > 0) {
      if (process.env.NODE_ENV === "production") {
        // На продакшені зберігаємо шляхи до файлів в сесії
        req.session = req.session || {};
        req.session.downloadUrls = downloadUrls;
      }
      res.json(results);
    } else {
      throw new Error("Failed to process any images");
    }
  } catch (error) {
    logError("process-images route", error);
    res.status(500).json({
      error: "Error processing images",
      details:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
      requestId: Date.now(),
    });
  }
});

// Додаємо маршрут для завантаження файлів
app.get("/download", async (req, res) => {
  try {
    const filePath = req.query.file;
    if (!filePath) {
      return res.status(400).json({ error: "File path not specified" });
    }

    // Перевіряємо чи файл існує
    try {
      await fs.access(filePath);
    } catch (error) {
      return res.status(404).json({ error: "File not found" });
    }

    // Отримуємо ім'я файлу
    const fileName = path.basename(filePath);

    // Відправляємо файл
    res.download(filePath, fileName, async (error) => {
      if (error) {
        logError("download", error);
        if (!res.headersSent) {
          res.status(500).json({ error: "Error downloading file" });
        }
      }

      // Видаляємо файл після відправки
      if (process.env.NODE_ENV === "production") {
        try {
          await fs.unlink(filePath);
          console.log(`Deleted file after download: ${filePath}`);
        } catch (unlinkError) {
          console.error(`Error deleting file: ${unlinkError.message}`);
        }
      }
    });
  } catch (error) {
    logError("download route", error);
    res.status(500).json({ error: "Error processing download request" });
  }
});

// Маршрут для відкриття папки
app.get("/open-folder", (req, res) => {
  const folderPath = req.query.path;
  if (!folderPath) {
    return res.status(400).json({ error: "Path not specified" });
  }

  const command =
    process.platform === "darwin"
      ? `open "${folderPath}"`
      : process.platform === "win32"
      ? `explorer "${folderPath}"`
      : `xdg-open "${folderPath}"`;

  exec(command, (error) => {
    if (error) {
      console.error("Error opening folder:", error);
      res.status(500).json({ error: "Failed to open folder" });
    } else {
      res.json({ success: true });
    }
  });
});

// Запускаємо сервер
(async () => {
  try {
    console.log("=== Server starting ===");
    console.log("Environment:", {
      nodeEnv: process.env.NODE_ENV || "development",
      platform: process.platform,
      nodeVersion: process.version,
      storageBase: STORAGE_BASE,
      cwd: process.cwd(),
      uid: process.getuid?.(),
      gid: process.getgid?.(),
    });

    await ensureStorageDir();
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      console.log(`Storage directory: ${STORAGE_BASE}`);
    });
  } catch (error) {
    logError("Server startup", error);
    process.exit(1);
  }
})();
