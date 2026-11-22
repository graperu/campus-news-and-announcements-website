# Màu giao diện UTH

Bảng màu tham chiếu từ [CSS website chính thức UTH](https://ut.edu.vn/themes/ut/css/styles.css?v=1.11), đối chiếu ngày 16/11/2026:

| Màu       | Giá trị   | Vị trí nguồn                      | Áp dụng trong dự án                                         |
| --------- | --------- | --------------------------------- | ----------------------------------------------------------- |
| Xanh ngọc | `#018486` | Menu chính và các khối điều hướng | Menu, utility bar, nút chính, banner và tab biên tập        |
| Đỏ        | `#AA1F00` | Nút menu và các khối nhấn         | Phụ đề thương hiệu, dấu nhấn chuyên mục và tiêu đề bảng tin |
| Vàng      | `#F3C50F` | Điểm nhấn điều hướng              | Viền menu, trạng thái menu đang chọn và nút trên banner     |

`#006568` là sắc xanh đậm bổ trợ do dự án chọn cho chữ nhỏ trên nền sáng. Nền, đường viền và chữ nội dung dùng màu trung tính; các trạng thái nghiệp vụ vẫn có màu phân biệt. Đây là tham chiếu màu từ giao diện web UTH, không phải tuyên bố đã áp dụng một cẩm nang thương hiệu in ấn.

Các token nằm đầu `frontend/styles/base.css`. Favicon và `theme-color` dùng cùng màu xanh ngọc chính.

Logo trên masthead dùng ảnh gốc từ [máy chủ chính thức UTH](https://ut.edu.vn/themes/ut/images/logo.png), lưu tại `frontend/assets/uth-logo.png`, giữ nguyên tỷ lệ, không vẽ lại hoặc đổi màu.

## Campus wordmark

`frontend/assets/campus-wordmark.svg` là dấu hiệu riêng của dự án Campus: biểu tượng sách mở/mái trường, chữ campus và điểm nhấn xanh ngọc/vàng. Đây là SVG mới, không phải bản vẽ lại logo chính thức UTH. Logo UTH nguồn gốc được giữ riêng; không phóng to ảnh raster để giả chất lượng vector. Favicon dùng cùng biểu tượng sách/mái trường.

Menu đang chọn dùng chữ trắng trên nền #018486 (khoảng 4.52:1); vàng dùng cho gạch chân, thay cho chữ vàng có tương phản thấp.
