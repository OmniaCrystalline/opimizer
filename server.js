/** @format */

const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const cors = require("cors");
const path = require("path");
const fs = require("fs").promises;
const os = require("os");
const { exec } = require("child_process");
const archiver = require("archiver");
const fsSync = require("fs");

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
  // Горизонтальні зображення
  hero: { width: 1920, height: 1080, watermark: true },
  heroRetina: { width: 3840, height: 2160, watermark: true },
  card: { width: 400, height: 300, watermark: true },
  cardRetina: { width: 800, height: 600, watermark: true },
  // Вертикальні зображення
  verticalHero: { width: 1080, height: 1920, watermark: true },
  verticalHeroRetina: { width: 2160, height: 3840, watermark: true },
  verticalCard: { width: 300, height: 400, watermark: true },
  verticalCardRetina: { width: 600, height: 800, watermark: true },
  // Квадратні зображення
  square: { width: 800, height: 800, watermark: true },
  squareRetina: { width: 1600, height: 1600, watermark: true },
  squareSmall: { width: 400, height: 400, watermark: true },
  squareSmallRetina: { width: 800, height: 800, watermark: true },
};

// Функція для створення SVG вотермарки з текстом
async function createWatermarkSvg(text) {
  const svg = `
    <svg width="500" height="100">
      <defs>
        <style>
          @font-face {
            font-family: 'System';
            src: local('Arial'), local('Helvetica');
          }
          .text { 
            fill: rgba(255, 255, 255, 0.5); 
            font-size: 48px; 
            font-family: 'System', sans-serif;
          }
        </style>
      </defs>
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

// Функція для визначення орієнтації зображення
async function getImageOrientation(filePath) {
  const metadata = await sharp(filePath).metadata();
  return metadata.width > metadata.height ? "horizontal" : "vertical";
}

// Функція для обробки зображення
async function processImage(file, config, targetFolder, watermarkText) {
  try {
    const filename = path.parse(file.originalname).name;
    const timestamp = Date.now();
    const isRetina = config.width > 1080 || config.height > 1920;

    const sizeFolder = `${config.width}x${config.height}`;
    const outputDir = path.join(targetFolder, sizeFolder);

    await fs.mkdir(outputDir, { recursive: true });

    // Формуємо назву файлу з розміром та позначкою ретіни
    let size;
    if (isRetina) {
      if (config.width === config.height) {
        size = config.width === 1600 ? "800x800@2x" : "400x400@2x";
      } else {
        size =
          config.width > config.height
            ? config.width === 3840
              ? "1920x1080@2x"
              : "400x300@2x"
            : config.width === 2160
            ? "1080x1920@2x"
            : "300x400@2x";
      }
    } else {
      if (config.width === config.height) {
        size = config.width === 800 ? "800x800" : "400x400";
      } else {
        size =
          config.width > config.height
            ? config.width === 1920
              ? "1920x1080"
              : "400x300"
            : config.width === 1080
            ? "1080x1920"
            : "300x400";
      }
    }

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

// Функція для створення ZIP-архіву з папки
async function createZipFromFolder(folderPath, zipPath) {
  return new Promise((resolve, reject) => {
    const output = fsSync.createWriteStream(zipPath);
    const archive = archiver("zip", {
      zlib: { level: 9 },
    });

    output.on("close", () => resolve(zipPath));
    archive.on("error", reject);

    archive.pipe(output);
    archive.directory(folderPath, false);
    archive.finalize();
  });
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

    // Отримуємо вибрану орієнтацію
    const orientation = req.body.orientation || "both";

    // Створюємо тимчасову папку для обробки
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const tempFolder = path.join(os.tmpdir(), `processing_${timestamp}`);
    await fs.mkdir(tempFolder, { recursive: true });

    const results = [];

    for (const file of req.files) {
      try {
        console.log(`Processing file: ${file.originalname}`);
        const processedImages = {};
        const imageOrientation = await getImageOrientation(file.path);

        for (const [configName, config] of Object.entries(imageConfigs)) {
          try {
            // Перевіряємо чи потрібно обробляти цю конфігурацію
            const isVerticalConfig = config.height > config.width;
            const isSquareConfig = config.height === config.width;

            if (orientation !== "both") {
              if (
                (orientation === "horizontal" &&
                  (isVerticalConfig || isSquareConfig)) ||
                (orientation === "vertical" &&
                  (!isVerticalConfig || isSquareConfig)) ||
                (orientation === "square" && !isSquareConfig)
              ) {
                continue;
              }
            }

            console.log(`Processing ${configName} version...`);
            const outputPath = await processImage(
              file,
              config,
              tempFolder,
              watermarkText
            );

            if (outputPath) {
              processedImages[configName] = outputPath;
              console.log(`Successfully processed ${configName} version`);
            }
          } catch (error) {
            logError(`processImage(${configName})`, error);
            processedImages[configName] = { error: error.message };
          }
        }

        results.push({
          originalName: file.originalname,
          orientation: imageOrientation,
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
      // Створюємо ZIP-архів
      const zipFileName = `processed_images_${timestamp}.zip`;
      const zipPath = path.join(os.tmpdir(), zipFileName);

      await createZipFromFolder(tempFolder, zipPath);

      // Видаляємо тимчасову папку з обробленими файлами
      try {
        await fs.rm(tempFolder, { recursive: true });
        console.log(`Deleted temp folder: ${tempFolder}`);
      } catch (error) {
        console.error(`Error deleting temp folder: ${error.message}`);
      }

      // Відправляємо ZIP-файл
      res.download(zipPath, zipFileName, async (error) => {
        if (error) {
          logError("download", error);
        }
        // Видаляємо ZIP-файл після відправки
        try {
          await fs.unlink(zipPath);
          console.log(`Deleted ZIP file: ${zipPath}`);
        } catch (unlinkError) {
          console.error(`Error deleting ZIP file: ${unlinkError.message}`);
        }
      });
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
