// LOGIN 

document.addEventListener('DOMContentLoaded', function() {
  const form = document.querySelector('section.login .main form');
  if (form) {
      form.addEventListener('submit', function(event) {
          console.log('PE')
          event.preventDefault();
      
          const email = document.querySelector('#email').value;
          const password = document.querySelector('#password').value;
          const provider = '';
      
          fetch('/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            credentials: 'same-origin', // Добавлено для отправки куки
            body: JSON.stringify({ email, password, provider }),
          })
          .then(response => response.json())
          .then(data => {
            if (data.message === 'User logged in successfully') {
              // Пользователь успешно вошел в систему
              // Перенаправляем пользователя на указанный маршрут
              window.location.href = data.redirectUrl;
            } else {
              // Показать сообщение об ошибке
              toast(data.message);
            }
          })
          .catch((error) => {
            console.error('Error:', error);
          });
        });
  }
});

// END LOGIN 


// REGISTER 

document.addEventListener('DOMContentLoaded', function() {
  const form = document.querySelector('section.register .main form');
  if (form) {
      form.addEventListener('submit', function(event) {
          event.preventDefault();
      
          const email = document.querySelector('#email').value;
          const password = document.querySelector('#password').value;
          const provider = '';
          const confirmPassword = document.querySelector('#confirmPassword').value;
      
          if (password !== confirmPassword) {
            toast('Passwords do not match');
            return;
          }
      
          fetch('/register', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            credentials: 'same-origin', // Добавлено для отправки куки
            body: JSON.stringify({ email, password, provider }),
          })
          .then(response => response.json())
          .then(data => {
            if (data.message === 'User registered successfully') {
              // Пользователь успешно зарегистрирован
              // Перенаправляем пользователя на страницу логина
              window.location.href = data.redirectUrl;
            } else {
              // Показать сообщение об ошибке
              toast(data.message);
            }
          })
          .catch((error) => {
            console.error('Error:', error);
          });
        });
      }
});

// END REGISTER 



// NAME ADD password UPDATE

const saveButton = document.querySelector('.profileInfo .save .btn');
if (saveButton) {
    saveButton.addEventListener('click', function(event) {
        event.preventDefault();
    
        const login = document.querySelector('.bio input').value;
        const oldPassword = document.querySelector('.profileInfo .old input').value;
        const newPassword = document.querySelector('.profileInfo .new .newPass').value;
        const confirmPassword = document.querySelector('.profileInfo .new input:last-child').value;


        // обновляем сразу буквы в окошке профиля 
        if (login) {
          let words = login.split(' ');
          let result = '';
      
          if (words.length >= 2) {
              // Если есть два или более слов, берем первую букву первого слова и первую букву второго слова
              result = words[0].charAt(0) + words[1].charAt(0);
          } else {
              // Если есть только одно слово, берем первые две буквы этого слова
              result = words[0].substring(0, 2);
          }
          let profileWords = document.querySelector('.map_header .info_panels .register .prof p');
          if (profileWords) {
            profileWords.innerHTML = result.toUpperCase();
          }
      
          console.log(result);
      }


        // If at least one password field is filled
        if (oldPassword || newPassword || confirmPassword) {
            // Check if all password fields are filled
            if (!oldPassword || !newPassword || !confirmPassword) {
                toast('Please fill all the password fields or clear them');
                return;
            }

            if (newPassword !== confirmPassword) {
                toast('Passwords do not match');
                return;
            }
        
            fetch('/update-password', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ oldPassword, newPassword }),
            })
            .then(response => response.json())
            .then(data => {
                if (data.message === 'Password updated successfully') {
                    toast('Password successfully updated!');
                } else {
                    toast(data.message);
                }
            })
            .catch((error) => {
                console.error('Error:', error);
            });
        } else {
            // If password fields are empty, update profile
            fetch('/update-profile', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ login }),
            })
            .then(response => response.json())
            .then(data => {
                if (data.message === 'Profile updated successfully') {
                    toast('Data successfully saved!');
                } else {
                    toast(data.message);
                }
            })
            .catch((error) => {
                console.error('Error:', error);
            });
        }
    });
}
  

// END CHANGE PASSWORD 







// REGISTER ESTABLISHMENT 
let regEstate = document.querySelector('section.register_company .main form');
if (regEstate) {
  regEstate.addEventListener('submit', function(event) {
    event.preventDefault();

    let establishment = {
        country: document.querySelector('section.register_company .main form .country').value,
        city: document.querySelector('section.register_company .main form .city').value,
        name: document.querySelector('section.register_company .main form .name').value,
        address: document.querySelector('section.register_company .main form .address').value,
        email: document.querySelector('section.register_company .main form .email').value,
        phone: document.querySelector('section.register_company .main form .phone').value,
        weekdayHours: {
            open: document.querySelector('section.register_company .main form .b .time.s').value,
            close: document.querySelector('section.register_company .main form .b .time.do').value
        },
        weekendHours: {
            open: document.querySelector('section.register_company .main form .v .time.s').value,
            close: document.querySelector('section.register_company .main form .v .time.do').value
        }
    };

    for (let key in establishment) {
      if (typeof establishment[key] === 'object') {
          for (let subKey in establishment[key]) {
              if (establishment[key][subKey] === '') {
                  toast('Please fill in all fields');
                  return;
              }
          }
      } else if (establishment[key] === '') {
          toast('Please fill in all fields');
          return;
      }
  }

    fetch('/register-establishment', {
      method: 'POST',
      headers: {
          'Content-Type': 'application/json'
      },
      body: JSON.stringify(establishment)
  }).then(response => {
      if (!response.ok) {
          return response.json().then(err => { throw new Error(err.message); });
      }
      return response.json();
  })
  .then(data => {
      // Скрываем форму
      regEstate.style.display = 'none';
      // Показываем сообщение об успешной отправке заявки
      document.querySelector('section.register_company .main .finish').classList.add('active');
      console.log(data);
  })
  .catch((error) => {
      toast('Error when submitting data: ' + error.message, 'error');
      console.error('Error:', error);
  });
  
    
});

}


// END REGISTER ESTABLISHMENT 








// SET RATING FROM USER 
var wrap = document.querySelector('.wrap_2');

if (wrap) {
  function updateStars() {
    var stars = document.querySelectorAll('.stars_vote .fa-star');
    
    var rating = 0;
  
    stars.forEach((star, index) => {
      star.addEventListener('mouseover', function() {
          resetStars();
          for (var i = 0; i <= index; i++) {
              stars[i].classList.add('active');
          }
      });
  
      star.addEventListener('click', function() {
          rating = index + 1;
  
          // Отправьте запрос на сервер с оценкой и идентификатором заведения
          fetch('/rateEstablishment', {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json'
              },
              body: JSON.stringify({establishmentId: currentEstablishmentId, rating: rating })
          })
          .then(response => response.json())
          .then(data => {

            let rating
            if (localStorage.getItem('lang') == 'ru') {
              rating = 'Спасибо, ваша оценка зачтена!'
            } else if (localStorage.getItem('lang') == 'en') {
              rating = 'Thank you, your assessment is credited!'
            }

              wrap.innerHTML = `<p>${rating}</p>`;
              wrap.querySelector('p').style.maxWidth = "180px";
          });
      });
    });
  
    wrap.addEventListener('mouseleave', function() {
        if (rating === 0) {
            resetStars();
        } else {
            for (var i = 0; i < rating; i++) {
                stars[i].classList.add('active');
            }
        }
    });
  
    function resetStars() {
        stars.forEach(star => {
            star.classList.remove('active');
        });
    }
  }
  
  // вызовите эту функцию после каждого обновления innerHTML
  updateStars();
  
}

// END SET RATING FROM USER 

















// MY ESTATES BUTTON 

// Найти кнопку и модальное окно по классу
var myEstatesBtn = document.querySelector('.myEstates');
var myEstatesModal = document.querySelector('.myEstablishments');

if (myEstatesModal && myEstatesBtn) {
  // Добавить обработчик событий для открытия модального окна
  myEstatesBtn.addEventListener('click', function() {
    
    myEstatesModal.classList.add("active");

    var establishmentsBlock = document.querySelector('.establishments');
    establishmentsBlock.innerHTML = "";
    fetch('/user-establishments', {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json'
        }
    })
    .then(response => response.json())
    .then(establishments => {
      establishments.forEach((establishment, index) => {
        // Получить рейтинги заведения
        fetch('/getRatings/' + establishment._id, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json'
          }
        })
        .then(response => response.json())
        .then(ratings => {
          // Вычислить средний рейтинг и количество оценок
          var totalRating = 0;
          ratings.forEach(rating => {
            totalRating += rating.rating;
          });
          var averageRating = ratings.length > 0 ? totalRating / ratings.length : 0;
          var ratingCount = ratings.length;
      
          // Определить статус онлайн/оффлайн
          var onlineStatus = establishment.online ? 'active' : '';
          var offlineStatus = establishment.online ? '' : 'active';
      

          let onl;
          let ofl;
          let rate;
          let open_till;
          let start;

          if (localStorage.getItem('lang') == 'ru') {
            onl = 'Онлайн'
            ofl = 'Оффлайн'
            rate = 'оценок'
            open_till = 'Открыто до'
            start = 'Запустить трансляцию'
          } else if (localStorage.getItem('lang') == 'en') {
            onl = 'Online'
            ofl = 'Offline'
            rate = 'rate'
            open_till = 'Open till'
            start = 'Start broadcasting'
          }



          // Добавить заведение на страницу
          var itemHTML = `
            <div class="item">
              <div class="head">
                <div class="online ${onlineStatus}">
                  <span>${onl}</span>
                </div>
                <div class="offline ${offlineStatus}">
                  <span>${ofl}</span>
                </div>
                <img class="settings" src="/img/settings.svg" alt="settings">
              </div>
              <div class="info">
                <p>${establishment.name}</p>
                <span>${establishment.address}</span>
                <div class="time_stars">
                  <p class="rating">${averageRating.toFixed(1)} <img src="/img/rating_star.svg" alt="rating"></p>
                  <p class="rating_count">${ratingCount} ${rate}</p>
                  <p class="opened">${open_till} ${establishment.weekdayHours.close}</p>
                </div>
              </div>
              <div class="foot">
                <button data-id="${establishment._id}" class="btn startStream">
                  <img src="/img/start.svg" alt="start">
                  ${start}
                </button>
              </div>
            </div>
          `;
      
          establishmentsBlock.innerHTML += itemHTML;
      
          // Найти шестеренку для этого заведения
          var settingsIcons = document.querySelectorAll('.item .settings');
          settingsIcons[index].dataset.id = establishment._id;

          estateListeners()
          

        })
        .catch(error => console.error('Error:', error));
      });
     
        
    })
    .catch(error => console.error('Error:', error));
});




function estateListeners() {

  // нажатие кнопок начала стрима 
  let startStreambtns = document.querySelectorAll('.startStream');
  startStreambtns.forEach((el) => {
    el.addEventListener('click', function(e) {
		this.classList.add('blocked');
		setTimeout(() => {
			this.classList.remove('blocked');
		}, 1000);


		let estateId = this.getAttribute('data-id');
		
		let offlineMark = this.parentElement.parentElement.querySelector('.myEstablishments .left-tab .item .head .offline');
		let onlineMark = this.parentElement.parentElement.querySelector('.myEstablishments .left-tab .item .head .online');

      if (this.classList.contains('active')) {

		console.log('закончили стрим');
		fetch('/updateEstablishmentOnlineStatus', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				userId: userId,
				establishmentId: estateId,
				online: false, // или true, в зависимости от того, что вы хотите установить
				peerId: ""
			})
		})
		.then(response => response.json())
		.then(data => {
			console.log(data);
		})
		.catch(error => {
			console.error('Ошибка:', error);
		});

	
		
		// Проверьте, существует ли локальный стрим
		if (localStream) {
			// Остановите все треки в стриме
			localStream.getTracks().forEach(function(track) {
				track.stop();
			});
			// Обнулите локальный стрим
			localStream = null;
		} else {
			toast('Нет активного стрима');
		}

    let start;

    if (localStorage.getItem('lang') == 'ru') {
      start = 'Запустить трансляцию'
    } else if (localStorage.getItem('lang') == 'en') {
      start = 'Start broadcasting'
    }


		e.target.classList.remove('active');
		e.target.innerHTML = `
					<img src="/img/start.svg" alt="start">
					${start}
				`
		offlineMark.classList.add('active');
		onlineMark.classList.remove('active');
      } else {
		// var video = document.getElementById('video');
		// Запрос разрешений на видео и звук
		if (localStream) {
			toast('У вас уже есть активный стрим, перезагрузите страницу для завершения')
		} else {
			navigator.mediaDevices.getUserMedia({ video: true, audio: true })
			.then(function(stream) {
			

				fetch('/updateEstablishmentOnlineStatus', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({
						userId: userId,
						establishmentId: estateId,
						online: true,
						peerId: peer_id  // или true, в зависимости от того, что вы хотите установить
					})
				})
				.then(response => response.json())
				.then(data => {
					console.log(data);
				})
				.catch(error => {
					console.error('Ошибка:', error);
				});
				// Начинаем стрим
				// video.srcObject = stream;
				// video.play();
				localStream = stream;

        let end;

        if (localStorage.getItem('lang') == 'ru') {
          end = 'Остановить трансляцию'
        } else if (localStorage.getItem('lang') == 'en') {
          end = 'Stop broadcasting'
        }


				e.target.classList.add('active');
				e.target.innerHTML = `
					<img src="/img/pause.svg" alt="start">
					${end}
				`;
				offlineMark.classList.remove('active');
				onlineMark.classList.add('active');

				// Звоним всем подключенным пирам и передаем им наш поток
				Object.values(peer.connections).forEach(function(conn) {
					var call = peer.call(conn[0].peer, stream);
					// call.on('stream', function(remoteStream) {
					//     // Показываем входящий поток в нашем видеоэлементе
					//     video.srcObject = remoteStream;
					// });
				});
				
			})
			.catch(function(err) {
				console.log('An error occurred: ' + err);
				if (err.name === 'NotFoundError') {
					toast('Веб-камера или микрофон не найдены. Подключите и попробуйте еще раз.');
				} else {
					toast('Произошла ошибка: ' + err.message, 'error');
				}
			});
		}
	  }
      
    });
  });
  


  // нажатие шестеренки 
  document.querySelectorAll('.item .settings').forEach(settingsIcon => {
    settingsIcon.addEventListener('click', function() {
      // Получить ID заведения из атрибута data-id
      var id = this.dataset.id;
      localStorage.setItem('settingsEstate', id);
  
      // Получить данные заведения с сервера
      fetch('/getEstablishments/' + id, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      })
      .then(response => response.json())
      .then(establishment => {
        // Заполнить поля ввода данными из заведения
        document.querySelector('.settingsOverlay .country').value = establishment.country;
        document.querySelector('.settingsOverlay .city').value = establishment.city;
        document.querySelector('.settingsOverlay .name').value = establishment.name;
        document.querySelector('.settingsOverlay .address').value = establishment.address;
        document.querySelector('.settingsOverlay .weekdaysOpen').value = establishment.weekdayHours.open; // время открытия в будни
        document.querySelector('.settingsOverlay .weekdaysClose').value = establishment.weekdayHours.close; // время закрытия в будни
        document.querySelector('.settingsOverlay .weekendOpen').value = establishment.weekendHours.open; // время открытия в выходные
        document.querySelector('.settingsOverlay .weekendClose').value = establishment.weekendHours.close; // время закрытия в выходные
  
        // Отобразить фотографии заведения
        var preview = document.querySelector('#preview');
        preview.innerHTML = ''; // Очистить предыдущие изображения
        console.log(establishment)
        establishment.photos.forEach(photoUrl => {
          var img = document.createElement('img');
          img.src = photoUrl;
          img.classList.add('obj');
          var removeBtn = document.createElement('button');
          removeBtn.textContent = 'Удалить';
          removeBtn.dataset.id = photoUrl; // Используем URL фотографии в качестве уникального идентификатора
          removeBtn.addEventListener('click', function(e) {
            // Удаляем div с изображением и кнопкой
            e.target.parentNode.remove();
            // Удаляем фотографию из filesArray
            filesArray = filesArray.filter(f => f.id !== e.target.dataset.id);
          });
          var imgContainer = document.createElement('div');
          imgContainer.classList.add('item');
          imgContainer.appendChild(img);
          imgContainer.appendChild(removeBtn);
          preview.appendChild(imgContainer);
        
          // Добавляем фотографию в filesArray
          filesArray.push({id: photoUrl, url: photoUrl});
        });
        
     
  
        // Открыть модальное окно
        document.querySelector('.settingsOverlay').classList.add('active');
      })
      .catch(error => console.error('Error:', error));
    });
  });
}





  // Найти элемент для закрытия модального окна
  var closeEstateModal = document.querySelector('.myEstablishments .close_estateModal');

  if (closeEstateModal) {
    // Добавить обработчик событий для закрытия модального окна
    closeEstateModal.addEventListener('click', function() {
      myEstatesModal.classList.remove("active");
    });
  }


}


// END MY ESTATES BUTTON 








// GOOGLE BUTTON 

let googlebtn = document.querySelector('button.google');
if (googlebtn) {
  googlebtn.addEventListener('click', function() {
    window.location.href = '/auth/google';
  });
}




// db.createUser(
//   {
//     user: "admin",
//     pwd: "supressordelestado",
//     roles: [ { role: "readWrite", db: "webcabar" } ]
//   }
// )
