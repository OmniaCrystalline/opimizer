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
      ? ["https://yourdomain.com"] // Замініть на ваш домен
      : ["http://localhost:3000"],
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
app.use(express.json());

// Перевіряємо наявність тимчасової директорії
const tmpDir = os.tmpdir();
async function ensureTempDir() {
  try {
    await fs.access(tmpDir);
  } catch (error) {
    console.error("Error accessing temp directory:", error);
    process.exit(1);
  }
}

// Налаштування multer для тимчасового збереження файлів
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, tmpDir);
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

// Оновлюємо маршрут для обробки зображень
app.post("/process-images", upload.array("images"), async (req, res) => {
  try {
    console.log("Processing request received");
    console.log("Files:", req.files);

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const watermarkText = req.body.watermarkText || "© My Company";

    // В продакшені використовуємо тимчасову директорію
    const outputBaseDir =
      process.env.NODE_ENV === "production"
        ? path.join(tmpDir, "processed_images")
        : path.join(process.env.HOME || process.env.USERPROFILE, "Downloads");

    const currentDate = new Date().toISOString().split("T")[0];
    const targetFolder = path.join(
      outputBaseDir,
      `processed_images_${currentDate}`
    );

    await fs.mkdir(targetFolder, { recursive: true });

    const results = [];
    for (const file of req.files) {
      try {
        console.log(`Processing file: ${file.originalname}`);
        const processedImages = {};

        for (const [configName, config] of Object.entries(imageConfigs)) {
          const outputPath = await processImage(
            file,
            config,
            targetFolder,
            watermarkText
          );
          processedImages[configName] = outputPath;
        }

        results.push({
          originalName: file.originalname,
          folder: targetFolder,
          processed: processedImages,
        });

        // Видаляємо тимчасовий файл
        await fs.unlink(file.path);
      } catch (error) {
        console.error(`Error processing file ${file.originalname}:`, error);
        // Додаємо помилку до результатів
        results.push({
          originalName: file.originalname,
          error: error.message,
        });
      }
    }

    if (results.length > 0) {
      res.json(results);
    } else {
      res.status(500).json({ error: "Failed to process any images" });
    }
  } catch (error) {
    console.error("Error in process-images route:", error);
    res.status(500).json({
      error: "Error processing images",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
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
    await ensureTempDir();
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
      console.log(`Temp directory: ${tmpDir}`);
    });
  } catch (error) {
    console.error("Error during server startup:", error);
    process.exit(1);
  }
})();
