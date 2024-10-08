const clientDatabase = require("./DB/clientDatabase.js")
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const FormData = require("form-data");
const multer = require("multer");
const crypto = require("crypto");
const cron = require("node-cron")
const dayjs = require('dayjs');
const utc = require("dayjs/plugin/utc");
const timezone = require('dayjs/plugin/timezone');
const cloudinary = require("cloudinary").v2;
const sharp = require("sharp");
const { exec } = require("child_process");
const { off, throwDeprecation } = require("process");
dayjs.extend(utc);
dayjs.extend(timezone);
const app = express();
app.use(express.json());
// app.use(cors({
//   origin: "https://macetas-brian.vercel.app" 
// }));
app.use(cors())

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const argentinaTime = dayjs().tz('America/Argentina/Buenos_Aires');

// Cloudinary variables
const preset_name = process.env.PRESET_NAMES_IMAGES;
const cloud_name = process.env.CLOUD_NAME_IMAGES;
const cloudinary_api_key = process.env.cloudinary_api_key;
const cloudinary_api_secret = process.env.CLOUDINARY_API_SECRET;
const cloudinary_url = `https://api.cloudinary.com/v1_1/${cloud_name}/image/upload`;
//

cloudinary.config({
    cloud_name: process.env.CLOUD_NAME_IMAGES,  // Asegúrate de que estas variables estén definidas
    api_key: process.env.cloudinary_api_key,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const timestamp = Math.floor(Date.now() / 1000);

app.get("/", (req,res)=> {
    res.send("SERVER ON")
})

//Carga de imagenes a cloudinary
const uploadToCloudinary = async (file) => {
    try {
      const filename = file.originalname || 'default-image';
      const formData = new FormData();
      formData.append("file", file.buffer, { filename: file.originalname });
      formData.append("upload_preset", preset_name);
  
      const response = await axios.post(cloudinary_url, formData, {
        headers: {
          "Content-Type": "multipart/form-data",
        },
      });
  
      return response.data.secure_url;
    } catch (error) {
      console.error("Error subiendo imagen:", error);
      
    }
  };
  
  // Extraer ID público de la URL de la imagen
  const extractPublicIdFromUrl = (url) => {
    const parts = url.split('/');
    const fileName = parts.pop();
    return fileName.split('.')[0];
  };
  
  // Generar firma para la solicitud de eliminación
  const generateSignature = (publicId, timestamp, apiSecret) => {
    return crypto.createHash('sha1')
      .update(`public_id=${publicId}&timestamp=${timestamp}${apiSecret}`)
      .digest('hex');
  };
  
  // Eliminar imagen de Cloudinary
  const deleteImageFromCloudinary = async (publicId) => {
    console.log("PublicId", publicId)
    const signature = generateSignature(publicId, timestamp, cloudinary_api_secret);
  
    try {
      const response = await axios.post(
        `https://api.cloudinary.com/v1_1/${cloud_name}/image/destroy`,
        `public_id=${publicId}&signature=${signature}&api_key=${cloudinary_api_key}&timestamp=${timestamp}`, 
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      
      if (response.data.result === 'ok') {
        console.log(response.data)
        return { code: 200 };
      } else {
        throw new Error(`Error al eliminar imagen: ${response.data}`);
      }
    } catch (error) {
      console.error("Error al eliminar imagen de Cloudinary:", error);
      throw new Error("Error al eliminar imagen");
    }
  };
  
  // Ruta para subir producto
  app.post("/upload-product", upload.array("productImages"), async (req, res) => {
    const client = await clientDatabase.connect();
    let imageUrls = [];
    
    try {
      await client.query('BEGIN');
    
      const { productCategory, productDescription, productName, productPrice } = req.body;
      const productImages = req.files;

      if (!productName || !productPrice || !productDescription || !productCategory || !productImages.length) {
        throw new Error("Faltan datos requeridos");
      }
  
      // Subir imágenes a Cloudinary
      imageUrls = await Promise.all(
        productImages.map(async (image) => await uploadToCloudinary(image))
      );
  
      // Insertar producto en la base de datos
      const insertProductQuery = `INSERT INTO products (id_product_category, description, name, price)
                                  VALUES ($1, $2, $3, $4) RETURNING id_product;`;
      const productResponse = await client.query(insertProductQuery, [productCategory, productDescription, productName, productPrice]);
  
      if (productResponse.rowCount === 0) throw new Error("No se pudo insertar el producto");
  
      const idProduct = productResponse.rows[0].id_product;
  
      // Insertar URLs de imágenes en la base de datos
      const insertImageQuery = `INSERT INTO product_images (id_product_image, image_url) VALUES ($1, $2);`;
      await Promise.all(
        imageUrls.map(async (imageUrl) => 
          await client.query(insertImageQuery, [idProduct, imageUrl])
        )
      );
  
      // Confirmar la transacción
      await client.query('COMMIT');
      res.status(200).json({ message:"Producto subido correctamente" });
    } catch (error) {
      // Hacer rollback en caso de error
      await client.query('ROLLBACK');
      console.error("Error al procesar el producto:", error);
  
      // Eliminar imágenes de Cloudinary si algo falló
      if (imageUrls.length > 0) {
        await Promise.all(imageUrls.map(async (imageUrl) => {
          const publicId = extractPublicIdFromUrl(imageUrl);
          await deleteImageFromCloudinary(publicId);
        }));
      }
  
      res.status(500).json({ success: false, message: "Error al subir el producto" });
    } finally {
      client.release();
    }
  });
  
  app.post("/upload-category", async (req, res) => {
    const client = await clientDatabase.connect();
    const categoryName = req.body.name;
    
    const query = `INSERT INTO categories (name) VALUES ($1) RETURNING id_category;`
    try {
      const response = await client.query(query, [categoryName]);
      if (response.rowCount > 0) {
        return res.status(200).json({message: "Categoría subida correctamente"});
      }else{
        return res.status(500).json({message: "Error al subir categoría"});
      }
    } catch (error) {
      console.log(error)
      return res.status(500).json({message: "Error al subir categoría"});
    }
  });

  app.get("/get-data", async (req, res) => {
    const client = await clientDatabase.connect();
    const query1 = "SELECT * FROM products;";
    const query2 = "SELECT * FROM categories;";
    const query3 = "SELECT * FROM product_images"
    const query4 = "SELECT * FROM promotions"
    const query5 = "SELECT * FROM banners"
    const query6 = "SELECT * FROM ajustes"
    try {
      const [products, categories, imageUrls, promotions, banners, ajustes] = await Promise.all([
        client.query(query1),
        client.query(query2),
        client.query(query3),
        client.query(query4),
        client.query(query5),
        client.query(query6),
      ]);
      
      return res.status(200).json({ 
        products: products.rows, 
        categories: categories.rows,
        imageUrls: imageUrls.rows,
        promotions: promotions.rows,
        banners: banners.rows,
        ajustes: ajustes.rows
      });
    } catch (error) {
      console.error("Error al obtener los datos:", error);
      return res.status(500).json({ message: "Error al obtener los datos" });
    } finally {
      client.release();
    }
  });

  app.put("/update-category", async (req, res) => {
    const client = await clientDatabase.connect();
    const { id, newValue } = req.body;
    const query = `UPDATE categories SET name = $1 WHERE id_category = $2;`
    try {
      const response = await client.query(query, [newValue, id]);
      if (response.rowCount > 0) {
        return res.status(200).json({message: "Categoría actualizada correctamente"});
      }else{
        return res.status(500).json({message: "Error al actualizar categoría"});
      }
    } catch (error) {
      console.log(error)
      return res.status(500).json({message: "Error al actualizar categoría"});
    }
  });

  app.delete("/delete-category/:id", async(req,res)=>{
    const client = await clientDatabase.connect();
    const { id } = req.params;
    console.log(id)
    const query = `DELETE FROM categories WHERE id_category = $1;`
    try {
      const response = await client.query(query, [id]);
      if (response.rowCount > 0) {
        return res.status(200).json({message: "Categoría eliminada correctamente"});
      }else{
        return res.status(500).json({message: "Error al eliminar categoría"});
      }
    } catch (error) {
      console.log(error)
      return res.status(500).json({message: "Error al eliminar categoría"});
    }
  })
  

  app.put("/edit-product", upload.array("newImages"), async (req, res) => {
    const { productID, newProduct, imagesToDelete } = req.body;
    if (!productID) {
      return res.status(404).json({message:"Producto no encontrado o eliminado"});
    }
    const newImages = req.files;
    const { productName, productPrice, productDescription, productCategory } = JSON.parse(newProduct);
    const client = await clientDatabase.connect();
    let imageUrls = [];
    let responseDeleteImages = [];
  
    try {
      const parsedUrlsToDelete = JSON.parse(imagesToDelete);
      console.log("Imagenes a eliminar: ", parsedUrlsToDelete)
      // Iniciar la transacción
      await client.query("BEGIN");
  
      // 1. Subir nuevas imágenes a Cloudinary si hay nuevas imágenes
      if (newImages.length > 0) {
        imageUrls = await Promise.all(
          newImages.map(async (image) => await uploadToCloudinary(image))
        );
        if (imageUrls.length === 0) {
          throw new Error("Error al subir las nuevas imagenes")
        }
      }
  
      // 2. Eliminar las imágenes que están en imagesToDelete tanto de Cloudinary como de la base de datos
      if (parsedUrlsToDelete.length > 0) {
        responseDeleteImages = await Promise.all(
          parsedUrlsToDelete.map(async (imageUrl) => {
            const publicId = extractPublicIdFromUrl(imageUrl);
            await deleteImageFromCloudinary(publicId); // Eliminar de Cloudinary
            return client.query(
              `DELETE FROM product_images WHERE image_url = $1 AND id_product_image = $2;`,
              [imageUrl, productID]
            ); // Eliminar de la base de datos
          })
        );

        console.log("Respuesta de eliminado: ", responseDeleteImages)
      }
  
      // 3. Insertar las nuevas imágenes subidas
      if (imageUrls.length > 0) {
        await Promise.all(
          imageUrls.map(async (imageUrl) =>
            await client.query(
              `INSERT INTO product_images (image_url, id_product_image) VALUES ($1, $2);`,
              [imageUrl, productID]
            )
          )
        );
      }
  
      // 4. Actualizar la información del producto
      const queryUpdateProduct = `
        UPDATE products
        SET name = $1, description = $2, price = $3, id_product_category = $4
        WHERE id_product = $5;
      `;
      const responseUpdateProduct = await client.query(queryUpdateProduct, [
        productName,
        productDescription,
        productPrice,
        productCategory,
        productID
      ]);
  
      // 5. Confirmar la transacción si todo fue bien
      if (responseUpdateProduct.rowCount > 0) {
        await client.query("COMMIT");
        return res.status(200).json({ message: "Producto actualizado correctamente" });
      } else {
        await client.query("ROLLBACK");
        return res.status(500).json({ message: "Error al actualizar el producto" });
      }
    } catch (error) {
      console.log(error);
      await client.query("ROLLBACK");
  
      // Si hubo error, eliminar las nuevas imágenes subidas a Cloudinary
      if (imageUrls.length > 0) {
        await Promise.all(
          imageUrls.map(async (imageUrl) => {
            const publicId = extractPublicIdFromUrl(imageUrl);
            await deleteImageFromCloudinary(publicId);
          })
        );
      }
  
      return res.status(500).json({ message: "Error al actualizar el producto" });
    } finally {
      client.release();
    }
  });

  app.put("/change-product-state", async (req, res) => {
    
    const client = await clientDatabase.connect();
    const { state, productID } = req.body;
    if (!productID) {
      return res.status(404).json({message: "Producto inexistente"});
    }
    if (typeof state !== "boolean" || !productID) {
      return res.status(400).json({ message: "Datos inválidos o incompletos" });
    }
  
    const query = `UPDATE products SET is_available = $1 WHERE id_product = $2;`;
  
    try {
      const response = await client.query(query, [state, productID]);
  
      if (response.rowCount > 0) {
        return res.status(200).json({ message: "Estado actualizado correctamente" });
      } else {
        return res.status(404).json({ message: "Producto no encontrado o no actualizado" });
      }
    } catch (error) {
      console.log(error);
      return res.status(500).json({ message: "Error interno del servidor al actualizar estado" });
    } finally {
      client.release();
    }
  });
  
  app.delete("/delete-product/:id", async (req, res) => {
    const client = await clientDatabase.connect();

    const { imagesToDelete } = req.body;
    const { id } = req.params;
  
    const query = `DELETE FROM products WHERE id_product = $1;`;
  
    try {
      const cloudinaryResponses = await Promise.all(
        imagesToDelete.map(async(imageUrl)=>{
          const publicId = extractPublicIdFromUrl(imageUrl.image_url);
          return await deleteImageFromCloudinary(publicId);
        })
      )
      if (cloudinaryResponses.length > 0 && cloudinaryResponses.every(val => val.code === 200)) {
        const response = await client.query(query, [id]);
  
        if (response.rowCount > 0) {
          return res.status(200).json({ message: "Producto eliminado correctamente" });
        } else {
          return res.status(404).json({ message: "Producto no encontrado o no eliminado" });
        }
      }else{
        return res.status(500).json({ message: "Error interno del servidor al eliminar el producto" });
      }
      
    } catch (error) {
      console.log(error);
      return res.status(500).json({ message: "Error interno del servidor al eliminar producto" });
    } finally {
      client.release();
    }
  })

  app.post("/save-promotion", upload.array("promotionImage"), async (req, res) => {
    const { promotionData, startDate, endDate, discount } = req.body;
    const { promotionName, promotionDescription, promotionPrice } = JSON.parse(promotionData);
    const im = req.files;
    let insertImages = [];
  
    if (!promotionName || !promotionDescription || !startDate || !endDate || !im) {
      return res.status(400).send("Datos inválidos o incompletos");
    }
    const client = await clientDatabase.connect();
    try {
      
      await client.query("BEGIN"); 
  
      insertImages = await Promise.all(
        im.map(async (image) => {
          return uploadToCloudinary(image);
        })
      );
  
      if (insertImages.length === 0) {
        throw new Error("Error al subir las nuevas imágenes");
      }
  
      console.log("Imágenes insertadas: ", insertImages);
  
      const query = `INSERT INTO promotions 
                    (name, description, start_date, end_date,price, discount, enabled, imageurl) 
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
      const responseQuery = await client.query(query, [
        promotionName,
        promotionDescription,
        dayjs(startDate).format("YYYY-MM-DD"),
        dayjs(endDate).format("YYYY-MM-DD"),
        promotionPrice || 0,
        discount,
        true, 
        insertImages[0], 
      ]);
  
      if (responseQuery.rowCount > 0) {
        await client.query("COMMIT");
        return res.status(200).json({ message: "Promoción guardada correctamente" });
      } else {
        throw new Error("Error al guardar la promoción en la base de datos");
      }
    } catch (error) {
      console.error("Error:", error.message);
  
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Error al hacer rollback:", rollbackError.message);
      }
  
      if (insertImages.length > 0) {
        await Promise.all(
          insertImages.map(async (imageUrl) => {
            const publicId = extractPublicIdFromUrl(imageUrl);
            await deleteImageFromCloudinary(publicId);
          })
        );
      }
  
      return res.status(500).send("Error al guardar la promoción");
    } finally {
      client.release();
    }
  });

  app.put("/change-promotion-status", async (req, res) => {
    const client = await clientDatabase.connect();
    console.log(req.body)
    const { status,promotionID,  } = req.body;
    if (!promotionID || typeof status !== "boolean") {
      return res.status(400).json({ message: "Datos inválidos o incompletos" });
    }
    const query = `UPDATE promotions SET enabled = $1 WHERE id_promotion = $2;`;
    try {
      const response = await client.query(query, [status, promotionID]);
      if (response.rowCount > 0) {
        return res.status(200).json({ message: "Promoción actualizada correctamente" });
      } else {
        return res.status(404).json({ message: "Promoción no encontrada o no actualizada" });
      }
    } catch (error) {
      console.log(error);
      return res.status(500).json({ message: "Error interno del servidor al actualizar estado" });
    } finally {
      client.release();
    }
  });

  app.put("/edit-promotion", upload.array("image"), async (req, res) => {
    const { promotionData, startDate, endDate, discount, removedImg, image,promotionID } = req.body;
    const { promotionName, promotionDescription, promotionPrice } = JSON.parse(promotionData);
    const newImg = req.files;
  
    if (!promotionName || !promotionDescription || !startDate || !endDate ) {
      return res.status(400).send("Datos inválidos o incompletos");
    }
  
    const client = await clientDatabase.connect();
    const query = `UPDATE promotions SET name = $1, description = $2, start_date = $3, end_date = $4, price = $5, discount = $6, imageurl = $7 WHERE id_promotion = $8;`;
  
    try {
      await client.query("BEGIN");
  
      let imageUrl = image; // Comenzamos con la imagen existente
  
      // 1. Eliminar imagen si existe removedImg
      if (removedImg) {
        const publicId = extractPublicIdFromUrl(removedImg);
        await deleteImageFromCloudinary(publicId); // Manejo de errores a nivel de Cloudinary
      }
  
      // 2. Subir nueva imagen si existe
      if (newImg.length > 0) {
        const uploadedImages = await Promise.all(
          newImg.map(async (image) => uploadToCloudinary(image))
        );
  
        if (uploadedImages.length === 0) {
          throw new Error("Error al subir las nuevas imágenes");
        }
  
        imageUrl = uploadedImages[0]; // Actualizamos imageUrl con la nueva imagen subida
      }
  
      // 3. Ejecutar la consulta de actualización con la imagen adecuada
      const responseQuery = await client.query(query, [
        promotionName,
        promotionDescription,
        dayjs(startDate).format("YYYY-MM-DD"),
        dayjs(endDate).format("YYYY-MM-DD"),
        promotionPrice || 0,
        discount,
        imageUrl, // Aquí usamos la URL que haya resultado del flujo anterior
        promotionID,
      ]);

      console.log(responseQuery)
  
      if (responseQuery.rowCount === 0) {
        throw new Error("Error al actualizar la promoción");
      }
  
      // 4. Confirmar transacción si todo salió bien
      await client.query("COMMIT");
      return res.status(200).json({ message: "Promoción actualizada correctamente" });
  
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Error al actualizar la promoción:", error);
      return res.status(500).json({ message: "Error al actualizar la promoción" });
    } finally {
      client.release();
    }
  });
  
  app.delete("/delete-promotion/:id", async (req, res) => {
    const client = await clientDatabase.connect();
    const {id}  = req.params;
    const { deleteImgUrl } = req.query;
    console.log(deleteImgUrl)
    if (!id) {
      return res.status(404).json({message: "Promoción no encontrada o no válida"});
    }
    const query = `DELETE FROM promotions WHERE id_promotion = $1;`;
    try {
      const publicId = extractPublicIdFromUrl(deleteImgUrl);
      const responseDeleteImg = await deleteImageFromCloudinary(publicId)
      if (responseDeleteImg.code === 200) {
        const response = await client.query(query, [id]);
        if (response.rowCount > 0) {
          return res.status(200).json({ message: "Promoción eliminada correctamente" });
        } else {
          return res.status(404).json({ message: "Promoción no encontrada o no eliminada" });
        }
      }else{
        return res.status(500).json({ message: "Error interno del servidor al eliminar la promoción" });
      }
    } catch (error) {
      console.log(error);
      return res.status(500).json({ message: "Error interno del servidor al eliminar la promoción" });
    } finally {
      client.release();
    }
  })

  app.post("/upload-banner", upload.array("bannerImage"), async (req, res) => {
    const client = await clientDatabase.connect();
    const { name } = req.body;
    const im = req.files;
    let uploadedImages = []
    if (!name || !im) {
      return res.status(400).send("Datos inválidos o incompletos");
    }
    const query = `INSERT INTO banners (nombre_banner, image_urls) VALUES ($1, $2);`;
    try {
       uploadedImages = await Promise.all(
        im.map(async (image) => uploadToCloudinary(image))
      );
  
      if (uploadedImages.length === 0) {
        throw new Error("Error al subir las nuevas imágenes");
      }
  
      const responseQuery = await client.query(query, [name, uploadedImages[0]]);
  
      if (responseQuery.rowCount === 0) {
        throw new Error("Error al insertar el banner");
      }
  
      return res.status(200).json({ message: "Banner insertado correctamente" });
    } catch (error) {
      console.error("Error al insertar el banner:", error);
      if (uploadedImages.length > 0) {
        await Promise.all(
          insertImages.map(async (imageUrl) => {
            const publicId = extractPublicIdFromUrl(imageUrl);
            await deleteImageFromCloudinary(publicId);
          })
        );
      }
      return res.status(500).json({ message: "Error al insertar el banner" });
    } finally {
      client.release();
    }
  });

  app.put("/update-banner", upload.array("newImage"), async (req, res) => {    
    const { image, removedImage, bannerName, bannerId } = req.body;
    const newIm = req.files; 

    const client = await clientDatabase.connect();
    const query = `UPDATE banners SET image_urls = $1, nombre_banner = $2 WHERE id = $3;`;

    let newImage = newIm;

    try {
      await client.query("BEGIN")
        if (!bannerId || !bannerName) {
            return res.status(400).json({ message: "Faltan datos obligatorios" });
        }

        if (Array.isArray(newIm) && newIm.length > 0) {
            newImage = await Promise.all(newIm.map(async (image) => uploadToCloudinary(image)));
            console.log("Nueva Imagen :", newImage)
            if (newImage.length === 0) {
                throw new Error("Error al subir la nueva imagen");
            }
            console.log("Nueva imagen: ",newImage[0])
            const responseUpdate = await client.query(query, [newImage[0], bannerName, bannerId]);

            if (responseUpdate.rowCount === 0) {
                throw new Error("Error actualizando el banner");
            }

            if (removedImage) {
                const publicId = extractPublicIdFromUrl(removedImage);
                const responseRemoveImage = await deleteImageFromCloudinary(publicId);

                if (!responseRemoveImage || responseRemoveImage.length === 0) {
                    throw new Error("No se pudo eliminar la imagen anterior");
                }
            }
        } else {
            const responseUpdate = await client.query(query, [image, bannerName, bannerId]);
            if (responseUpdate.rowCount === 0) {
                throw new Error("Error actualizando el banner");
            }
        }
        await client.query("COMMIT")
        return res.status(200).json({ message: "Banner actualizado correctamente" });
    } catch (error) {
        console.log(error);
        await client.query("ROLLBACK")
        if (Array.isArray(newImage) && newImage.length > 0) {
            await Promise.all(
                newImage.map(async (imageUrl) => {
                    const publicId = extractPublicIdFromUrl(imageUrl);
                    await deleteImageFromCloudinary(publicId);
                })
            );
        }

        return res.status(500).json({ message: "Error al actualizar el banner" });
    } finally {
        client.release(); 
    }
});

app.delete("/delete-banner/:bannerId", async(req,res)=> {
  const client = await clientDatabase.connect();
  const {bannerUrl} = req.query;
  const { bannerId } = req.params
  const query = `DELETE FROM banners WHERE id=$1`
  try {
    await client.query("BEGIN")

    if (!bannerId || !bannerUrl) {
      return res.status(400).json({ message: "Faltan datos obligatorios" });
    }

    const responseDeleteQuery = await client.query(query, [bannerId]);
    if (responseDeleteQuery.rowCount === 0) {
      throw new Error("Error al eliminar el banner");
    }
    const clientId = extractPublicIdFromUrl(bannerUrl);
    const responseDeleteImage = await deleteImageFromCloudinary(clientId);

    if (responseDeleteImage.code === 200) {
      await client.query("COMMIT")
      return res.status(200).json({message: "Banner eliminado correctamente"});
    }else{
      throw new Error("Error al eliminar la imagen");
    }
  } catch (error) {
    await client.query("ROLLBACK")
    return res.status(500).json({ message: "Error al eliminar el banner" });
  }
});
  
app.put("/update-settings", async(req,res)=> {
  const client = await clientDatabase.connect();
  const settings = req.body
  console.log(settings)
  
  const query = "UPDATE ajustes SET settings = $1 WHERE id = 2"

  try {
    if (!settings) {
      return res.status(400).json({ message: "Faltan datos obligatorios" });
    }

    const response = await client.query(query, [settings]);
    if (response.rowCount > 0) {
      return res.status(200).json({message: "Ajustes actualizados correctamente"});
    }

    return res.status(400).json({message: "Error actualizando los ajustes"})
  } catch (error) {
    console.log(error)
    return res.status(500).json({message: "Error al actualizar los ajustes"})
  }
})

cron.schedule("* * * * *", async () => {
  const client = await clientDatabase.connect();
  const argentinaTime = dayjs().tz('America/Argentina/Buenos_Aires').format("YYYY-MM-DD");
  const query = "UPDATE promotions SET enabled = false WHERE end_date = $1"
  try {
    const response = await client.query(query, [argentinaTime]);
    if (response.rowCount > 0) {
      console.log("Promociones actualizadas correctamente");
    }else{
      console.log("No se encontraron promociones");
    }

  } catch (error) {
    console.log(error)

  }
})

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
  });